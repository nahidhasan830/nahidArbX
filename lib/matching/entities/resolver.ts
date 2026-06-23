
import { Client } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { db } from "../../db/client";
import { sql } from "drizzle-orm";
import {
  findActiveByCompetitionAnyProvider,
  findActiveByGlobalSurface,
  findActiveEntityNameForLookup,
  getEntityById,
  type EntityRow,
} from "../../db/repositories/entities";
import { logger } from "../../shared/logger";
import { singleton } from "../../util/singleton";
import { embed as embedViaMatcher } from "./matcher-client";
import { normalize, normalizeCompetition } from "./normalize";

const tag = "EntityResolver";

interface CacheEntry {
  result: ResolvedSurface | null;
  expiresAt: number;
}

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_SIZE = 5_000;

const cache = singleton(
  "entities:resolver:cache",
  () => new Map<string, CacheEntry>(),
);

function cacheKey(
  provider: string,
  surface: string,
  competitionId: string | null,
): string {
  return `${provider}|${surface}|${competitionId ?? "_"}`;
}

function pruneCacheIfNeeded(): void {
  if (cache.size <= CACHE_MAX_SIZE) return;
  const target = Math.floor(CACHE_MAX_SIZE * 0.8);
  let removed = 0;
  for (const key of cache.keys()) {
    if (cache.size <= target) break;
    cache.delete(key);
    removed++;
  }
  logger.info(tag, `LRU cache pruned: removed ${removed}`);
}

export function clearResolverCache(): void {
  if (cache.size) {
    logger.info(tag, `Resolver cache cleared (${cache.size} entries)`);
  }
  cache.clear();
}

export interface ResolvedSurface {
  entity: EntityRow;
  source: "exact" | "cross-provider" | "global" | "embedding";
  surfaceNormalized: string;
}

export async function resolveTeamSurface(opts: {
  provider: string;
  surface: string;
  competitionId: string | null;
}): Promise<ResolvedSurface | null> {
  const surfaceNormalized = normalize(opts.surface);
  if (!surfaceNormalized) return null;

  const key = cacheKey(opts.provider, surfaceNormalized, opts.competitionId);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const result = await runResolveSteps({
    provider: opts.provider,
    surfaceNormalized,
    competitionId: opts.competitionId,
  });
  cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  pruneCacheIfNeeded();
  return result;
}

export async function resolveCompetitionSurface(opts: {
  provider: string;
  surface: string;
}): Promise<ResolvedSurface | null> {
  const surfaceNormalized = normalizeCompetition(opts.surface);
  if (!surfaceNormalized) return null;

  const key = cacheKey(opts.provider, surfaceNormalized, null);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const result = await runResolveSteps({
    provider: opts.provider,
    surfaceNormalized,
    competitionId: null,
  });
  cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  pruneCacheIfNeeded();
  return result;
}

async function runResolveSteps(opts: {
  provider: string;
  surfaceNormalized: string;
  competitionId: string | null;
}): Promise<ResolvedSurface | null> {
  const exact = await findActiveEntityNameForLookup({
    provider: opts.provider,
    surfaceNormalized: opts.surfaceNormalized,
    competitionId: opts.competitionId,
  });
  if (exact) {
    const ent = await getEntityById(exact.entityId);
    if (ent && !ent.retiredAt) {
      return {
        entity: ent,
        source: "exact",
        surfaceNormalized: opts.surfaceNormalized,
      };
    }
  }

  if (opts.competitionId !== null) {
    const crossProv = await findActiveByCompetitionAnyProvider({
      surfaceNormalized: opts.surfaceNormalized,
      competitionId: opts.competitionId,
    });
    const distinctEntityIds = new Set(crossProv.map((r) => r.entityId));
    if (distinctEntityIds.size === 1) {
      const ent = await getEntityById([...distinctEntityIds][0]);
      if (ent && !ent.retiredAt) {
        return {
          entity: ent,
          source: "cross-provider",
          surfaceNormalized: opts.surfaceNormalized,
        };
      }
    }
  }

  const globalRows = await findActiveByGlobalSurface(opts.surfaceNormalized);
  const distinctGlobalEntityIds = new Set(globalRows.map((r) => r.entityId));
  if (distinctGlobalEntityIds.size === 1) {
    const ent = await getEntityById([...distinctGlobalEntityIds][0]);
    if (ent && !ent.retiredAt) {
      return {
        entity: ent,
        source: "global",
        surfaceNormalized: opts.surfaceNormalized,
      };
    }
  }

  if (
    process.env.EMBEDDING_LOOKUP_ENABLED === "true" &&
    opts.competitionId !== null
  ) {
    try {
      const embedding = await embedSurface(opts.surfaceNormalized);
      if (embedding) {
        const rows = await db.execute<{
          id: string;
          entity_id: string;
          cosine: number;
        }>(
          sql.raw(
            `SELECT id, entity_id,
                  1 - (surface_embedding <=> '${formatVectorLiteral(embedding)}'::vector) AS cosine
             FROM entity_names
            WHERE status = 'active'
              AND competition_id = '${opts.competitionId}'
              AND surface_embedding IS NOT NULL
            ORDER BY surface_embedding <=> '${formatVectorLiteral(embedding)}'::vector
            LIMIT 3`,
          ),
        );
        const close = (rows.rows ?? []).filter((r) => r.cosine >= 0.92);
        const distinctEntities = new Set(close.map((r) => r.entity_id));
        if (close.length > 0 && distinctEntities.size === 1) {
          const ent = await getEntityById([...distinctEntities][0]);
          if (ent && !ent.retiredAt) {
            return {
              entity: ent,
              source: "embedding",
              surfaceNormalized: opts.surfaceNormalized,
            };
          }
        }
      }
    } catch (err) {
      logger.warn(tag, `Embedding fallback failed: ${(err as Error).message}`);
    }
  }

  return null;
}

async function embedSurface(surface: string): Promise<number[] | null> {
  return embedViaMatcher(surface);
}

function formatVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

export const ENTITY_CACHE_INVAL_CHANNEL = "entities_invalidate";

export async function notifyResolverInvalidation(): Promise<void> {
  try {
    await db.execute(sql.raw(`NOTIFY ${ENTITY_CACHE_INVAL_CHANNEL}`));
  } catch {
  }
}

interface ListenerState {
  active: boolean;
  client: Client | null;
}
const listenerState = singleton<ListenerState>(
  "entities:resolver:listener",
  () => ({ active: false, client: null }),
);

export async function startResolverCacheListener(): Promise<void> {
  if (listenerState.active) return;
  const url = process.env.DATABASE_URL;
  if (!url) {
    logger.warn(tag, "DATABASE_URL not set — skipping cache listener");
    return;
  }
  try {
    const instance = process.env.CLOUD_SQL_INSTANCE;
    let client: Client;

    if (instance) {
      const parsed = new URL(url);
      const user = decodeURIComponent(parsed.username);
      const password = decodeURIComponent(parsed.password);
      const database = parsed.pathname.slice(1);

      const connector = new Connector();
      const clientOpts = await connector.getOptions({
        instanceConnectionName: instance,
        ipType: IpAddressTypes.PUBLIC,
      });
      client = new Client({ ...clientOpts, user, password, database });
    } else {
      client = new Client({ connectionString: url });
    }

    await client.connect();
    await client.query(`LISTEN ${ENTITY_CACHE_INVAL_CHANNEL}`);
    client.on("notification", () => clearResolverCache());
    client.on("error", (err) => {
      logger.warn(tag, `LISTEN client error: ${err.message}`);
    });
    listenerState.client = client;
    listenerState.active = true;
    logger.info(
      tag,
      `Cache invalidation listener started (${instance ? "Cloud SQL" : "local"})`,
    );
  } catch (err) {
    logger.warn(
      tag,
      `Could not start cache listener: ${(err as Error).message}`,
    );
  }
}

export function isResolverCacheListenerActive(): boolean {
  return listenerState.active;
}
