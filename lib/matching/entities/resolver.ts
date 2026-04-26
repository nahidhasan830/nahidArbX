/**
 * Lookup hot path — resolves a (provider, surface, competition) tuple to
 * an entity. Replaces the legacy `applyTeamAlias` / `applyCompetitionAlias`
 * functions in `lib/matching/normalize.ts`.
 *
 * Strategy (cheapest first, stop on hit):
 *   1. Tournament-scoped exact lookup (the common case, ~95% hit when
 *      the candidate has been promoted).
 *   2. Cross-provider fallback within the same competition (a NW-SB
 *      surface might match a Pinnacle-learned alias for the same team).
 *   3. Global fallback — only fires when there's a SINGLE active row
 *      across all competitions for this surface (unambiguous names).
 *   4. Embedding-cosine fallback (pgvector) — only when a `competition_id`
 *      is known. Catches the transliteration class of bugs (Cyrillic /
 *      Vietnamese / Arabic). Off by default until the entity-classifier
 *      Job has populated embeddings; gated by `EMBEDDING_LOOKUP_ENABLED`
 *      env (set to "true" once the classifier Job has landed embeddings).
 *
 * In-process LRU cache keyed by (provider, surface_normalized,
 * competition_id) with a 30s TTL — Postgres LISTEN/NOTIFY invalidates on
 * any entity_names mutation so multi-worker views stay consistent.
 */

import { Client } from "pg";
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

// MEMORY-LEAK GUARD — DO NOT REMOVE.
// Pinned to globalThis via singleton(). Without this, every Next.js HMR
// reload of this module would create a fresh empty Map; the previous
// Map (referenced by the LISTEN client below and by in-flight resolver
// promises) would survive in memory and the new Map would start cold,
// doubling DB-lookup pressure during long dev sessions.
// Same pattern as lib/store.ts and lib/scores/websocket.ts.
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
  // Drop the oldest 20% — Map iterates in insertion order so this is O(n).
  const target = Math.floor(CACHE_MAX_SIZE * 0.8);
  let removed = 0;
  for (const key of cache.keys()) {
    if (cache.size <= target) break;
    cache.delete(key);
    removed++;
  }
  logger.info(tag, `LRU cache pruned: removed ${removed}`);
}

/** Clears the entire process-local LRU cache. Called by the promoter
 *  after every promotion/demotion, and on alias-related mutations from
 *  the UI. The cross-worker invalidation pathway is the LISTEN/NOTIFY
 *  channel — see `subscribeToInvalidations()` below.
 */
export function clearResolverCache(): void {
  if (cache.size) {
    logger.info(tag, `Resolver cache cleared (${cache.size} entries)`);
  }
  cache.clear();
}

export interface ResolvedSurface {
  entity: EntityRow;
  source: "exact" | "cross-provider" | "global" | "embedding";
  /** Original surface_normalized (the cache key for diagnostics). */
  surfaceNormalized: string;
}

/**
 * Resolve a team surface name to an entity. Returns null if no active
 * row matches and the embedding fallback also fails — caller should
 * treat the surface as "unknown" and let the recordObservation path
 * (called from the matcher) seed a new candidate.
 */
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

/**
 * Resolve a competition surface to a competition entity. Same algorithm
 * but always uses `competitionId = null` since competitions ARE the top
 * level of the hierarchy.
 */
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
  // 1. Tournament-scoped exact (provider + competition + surface)
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

  // 2. Cross-provider, same competition
  if (opts.competitionId !== null) {
    const crossProv = await findActiveByCompetitionAnyProvider({
      surfaceNormalized: opts.surfaceNormalized,
      competitionId: opts.competitionId,
    });
    // If exactly one entity owns this surface in this competition (across
    // any provider) we can adopt it. Multiple = conflict, surface to the
    // operator via the candidate flow rather than guessing.
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

  // 3. Global fallback (only for unambiguous names — exactly one match
  //    across all comps and all providers).
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

  // 4. Embedding-cosine fallback. Disabled until the classifier Job has
  //    populated the surface_embedding column. When enabled, runs an
  //    ivfflat NN search bounded to the same competition_id; only adopts
  //    when a SINGLE active row sits within the cosine cutoff.
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
      // Don't let embedding failures break the matching hot path.
      logger.warn(tag, `Embedding fallback failed: ${(err as Error).message}`);
    }
  }

  return null;
}

// ── Embedding bridge ──────────────────────────────────────────────────
//
// Delegates to the entity-matcher Cloud Run Service via its typed client.
// The matcher service hosts BGE-M3 (1024-dim multilingual). The trainer
// Job populates `entity_names.surface_embedding` in batch; this runtime
// path only embeds the incoming surface to compare against existing rows.
async function embedSurface(surface: string): Promise<number[] | null> {
  return embedViaMatcher(surface);
}

function formatVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

// ── Cross-worker cache invalidation (Postgres LISTEN / NOTIFY) ──────
//
// Dropped if the LISTEN channel can't be set up — the 30 s LRU TTL is
// the fallback consistency floor. `autoResolve()` calls
// `notifyResolverInvalidation()` on every status flip; every Next.js
// worker subscribed via `startResolverCacheListener()` clears its local
// cache on receipt.
export const ENTITY_CACHE_INVAL_CHANNEL = "entities_invalidate";

export async function notifyResolverInvalidation(): Promise<void> {
  try {
    await db.execute(sql.raw(`NOTIFY ${ENTITY_CACHE_INVAL_CHANNEL}`));
  } catch {
    // best-effort
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

/**
 * Subscribe to the cache-invalidation NOTIFY channel. Idempotent — the
 * singleton means HMR reloads in dev don't multiply listeners. Failures
 * are logged but don't throw — the resolver still works without it
 * (just relying on the 30 s LRU TTL for consistency).
 */
export async function startResolverCacheListener(): Promise<void> {
  if (listenerState.active) return;
  const url = process.env.DATABASE_URL;
  if (!url) {
    logger.warn(tag, "DATABASE_URL not set — skipping cache listener");
    return;
  }
  try {
    const client = new Client({ connectionString: url });
    await client.connect();
    await client.query(`LISTEN ${ENTITY_CACHE_INVAL_CHANNEL}`);
    client.on("notification", () => clearResolverCache());
    client.on("error", (err) => {
      logger.warn(tag, `LISTEN client error: ${err.message}`);
    });
    listenerState.client = client;
    listenerState.active = true;
    logger.info(tag, "Cache invalidation listener started");
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
