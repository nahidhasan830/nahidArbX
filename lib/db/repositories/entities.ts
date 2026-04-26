/**
 * Entity Resolution — Postgres repository.
 *
 * One ingress for the matching/settlement pipeline (`recordObservation`),
 * one lookup function for the hot path (`resolveEntity`), and a small
 * surface for the promoter / UI / Cloud Run Jobs to read and mutate state.
 *
 * Identity is keyed by deterministic IDs:
 *   - entity:    `${kind}|${country ?? '_'}|${gender ?? '_'}|${slug}`
 *   - entity_name: random uuid (no natural key — surface is in (provider,
 *                  surface_normalized, competition_id) UNIQUE)
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../client";
import {
  entities,
  entityNames,
  nameObservations,
  entityDecisionBlocklist,
  type EntityNameRow,
  type EntityRow,
  type NewEntityNameRow,
  type NewEntityRow,
  type NewNameObservationRow,
} from "../schema";

export type { EntityRow, EntityNameRow };

// ─── Types ───────────────────────────────────────────────────────────────

export type EntityKind = "team" | "competition";
export type EntityNameStatus = "candidate" | "active" | "retired";
export type ObservationOutcome =
  | "matched"
  | "rejected"
  | "near-match"
  | "manual-confirm"
  | "manual-reject";
export type ObservationSource =
  | "harvester"
  | "match-review"
  | "learner"
  | "settle";

export interface ResolveResult {
  entity: EntityRow;
  entityName: EntityNameRow;
  source: "exact" | "global" | "embedding";
}

// ─── Slug helper ────────────────────────────────────────────────────────

/** Stable slug for entity IDs: lowercase + ascii + hyphens. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "_"
  );
}

export function buildEntityId(input: {
  kind: EntityKind;
  canonicalName: string;
  country?: string | null;
  gender?: string | null;
}): string {
  const country = input.country ?? "_";
  const gender = input.gender ?? "_";
  return `${input.kind}|${country}|${gender}|${slugify(input.canonicalName)}`;
}

// ─── Entity CRUD ────────────────────────────────────────────────────────

export async function getEntityById(id: string): Promise<EntityRow | null> {
  const rows = await db.select().from(entities).where(eq(entities.id, id));
  return rows[0] ?? null;
}

export async function getEntityByCanonical(
  kind: EntityKind,
  canonicalName: string,
): Promise<EntityRow | null> {
  const rows = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.kind, kind),
        sql`lower(${entities.canonicalName}) = ${canonicalName.toLowerCase()}`,
        isNull(entities.retiredAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface UpsertEntityInput {
  kind: EntityKind;
  canonicalName: string;
  country?: string | null;
  gender?: string | null;
  parentId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Idempotent: returns the existing row if the id collides. */
export async function upsertEntity(
  input: UpsertEntityInput,
): Promise<EntityRow> {
  const id = buildEntityId(input);
  const existing = await getEntityById(id);
  if (existing) return existing;

  const row: NewEntityRow = {
    id,
    kind: input.kind,
    canonicalName: input.canonicalName,
    country: input.country ?? null,
    gender: input.gender ?? null,
    parentId: input.parentId ?? null,
    metadata: input.metadata ?? {},
  };
  const [inserted] = await db
    .insert(entities)
    .values(row)
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  // Conflict — re-read.
  const reread = await getEntityById(id);
  if (!reread)
    throw new Error(`upsertEntity: row vanished after conflict (${id})`);
  return reread;
}

export async function listEntities(
  opts: {
    kind?: EntityKind;
    search?: string;
    includeRetired?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): Promise<EntityRow[]> {
  const conds = [];
  if (opts.kind) conds.push(eq(entities.kind, opts.kind));
  if (!opts.includeRetired) conds.push(isNull(entities.retiredAt));
  if (opts.search && opts.search.trim()) {
    const q = `%${opts.search.trim().toLowerCase()}%`;
    conds.push(sql`lower(${entities.canonicalName}) LIKE ${q}`);
  }
  const where = conds.length ? and(...conds) : undefined;
  return db
    .select()
    .from(entities)
    .where(where)
    .orderBy(entities.canonicalName)
    .limit(opts.limit ?? 200)
    .offset(opts.offset ?? 0);
}

export async function retireEntity(id: string): Promise<void> {
  await db
    .update(entities)
    .set({ retiredAt: new Date().toISOString() })
    .where(eq(entities.id, id));
  // Cascade: all entity_names of this entity become retired.
  await db
    .update(entityNames)
    .set({ status: "retired", retiredAt: new Date().toISOString() })
    .where(eq(entityNames.entityId, id));
}

/**
 * Merge entity `fromId` into `intoId`: rewires every entity_name and
 * observation, then retires `fromId`. Atomic — wrapped in a transaction.
 */
export async function mergeEntities(
  fromId: string,
  intoId: string,
): Promise<void> {
  if (fromId === intoId) return;
  await db.transaction(async (tx) => {
    await tx
      .update(entityNames)
      .set({ entityId: intoId })
      .where(eq(entityNames.entityId, fromId));
    await tx
      .update(nameObservations)
      .set({ pairedWithEntityId: intoId })
      .where(eq(nameObservations.pairedWithEntityId, fromId));
    await tx
      .update(entities)
      .set({ retiredAt: new Date().toISOString() })
      .where(eq(entities.id, fromId));
  });
}

// ─── Entity-name CRUD ──────────────────────────────────────────────────

export async function getEntityNamesForEntity(
  entityId: string,
): Promise<EntityNameRow[]> {
  return db
    .select()
    .from(entityNames)
    .where(eq(entityNames.entityId, entityId))
    .orderBy(desc(entityNames.weight));
}

export async function findEntityNameRow(opts: {
  provider: string;
  surfaceNormalized: string;
  competitionId: string | null;
}): Promise<EntityNameRow | null> {
  const rows = await db
    .select()
    .from(entityNames)
    .where(
      and(
        eq(entityNames.provider, opts.provider),
        eq(entityNames.surfaceNormalized, opts.surfaceNormalized),
        opts.competitionId === null
          ? isNull(entityNames.competitionId)
          : eq(entityNames.competitionId, opts.competitionId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getEntityNameById(
  id: string,
): Promise<EntityNameRow | null> {
  const rows = await db
    .select()
    .from(entityNames)
    .where(eq(entityNames.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function findActiveEntityNameForLookup(opts: {
  provider: string;
  surfaceNormalized: string;
  competitionId: string | null;
}): Promise<EntityNameRow | null> {
  const rows = await db
    .select()
    .from(entityNames)
    .where(
      and(
        eq(entityNames.provider, opts.provider),
        eq(entityNames.surfaceNormalized, opts.surfaceNormalized),
        opts.competitionId === null
          ? isNull(entityNames.competitionId)
          : eq(entityNames.competitionId, opts.competitionId),
        eq(entityNames.status, "active"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findActiveByCompetitionAnyProvider(opts: {
  surfaceNormalized: string;
  competitionId: string | null;
}): Promise<EntityNameRow[]> {
  return db
    .select()
    .from(entityNames)
    .where(
      and(
        eq(entityNames.surfaceNormalized, opts.surfaceNormalized),
        opts.competitionId === null
          ? isNull(entityNames.competitionId)
          : eq(entityNames.competitionId, opts.competitionId),
        eq(entityNames.status, "active"),
      ),
    )
    .limit(5);
}

export async function findActiveByGlobalSurface(
  surfaceNormalized: string,
): Promise<EntityNameRow[]> {
  return db
    .select()
    .from(entityNames)
    .where(
      and(
        eq(entityNames.surfaceNormalized, surfaceNormalized),
        eq(entityNames.status, "active"),
      ),
    )
    .limit(5);
}

export interface UpsertNameInput {
  entityId: string;
  competitionId: string | null;
  provider: string;
  surfaceRaw: string;
  surfaceNormalized: string;
  status?: EntityNameStatus;
  initialWeight?: number;
  initialPositiveObs?: number;
}

/**
 * Insert or fetch an entity_names row for (provider, surface_normalized,
 * competition_id). Idempotent — first call creates as `candidate`,
 * subsequent calls return the existing row (use updateNameAfterObservation
 * to evolve the counters/weights).
 */
export async function upsertEntityName(
  input: UpsertNameInput,
): Promise<EntityNameRow> {
  const existing = await findEntityNameRow({
    provider: input.provider,
    surfaceNormalized: input.surfaceNormalized,
    competitionId: input.competitionId,
  });
  if (existing) return existing;

  const row: NewEntityNameRow = {
    id: randomUUID(),
    entityId: input.entityId,
    competitionId: input.competitionId,
    provider: input.provider,
    surfaceRaw: input.surfaceRaw,
    surfaceNormalized: input.surfaceNormalized,
    weight: input.initialWeight ?? 1,
    positiveObs: input.initialPositiveObs ?? 0,
    negativeObs: 0,
    status: input.status ?? "candidate",
  };
  const [inserted] = await db
    .insert(entityNames)
    .values(row)
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const reread = await findEntityNameRow({
    provider: input.provider,
    surfaceNormalized: input.surfaceNormalized,
    competitionId: input.competitionId,
  });
  if (!reread) throw new Error("upsertEntityName: race lost both ways");
  return reread;
}

export async function updateNameAfterObservation(
  id: string,
  delta: {
    positiveObsDelta?: number;
    negativeObsDelta?: number;
    weightDelta?: number;
    classifierScore?: number | null;
    conformalPvalue?: number | null;
  },
): Promise<void> {
  const set: Record<string, unknown> = { lastSeenAt: new Date().toISOString() };
  const sets: string[] = [`last_seen_at = NOW()`];
  if (delta.positiveObsDelta) {
    sets.push(
      `positive_obs = positive_obs + ${Math.trunc(delta.positiveObsDelta)}`,
    );
  }
  if (delta.negativeObsDelta) {
    sets.push(
      `negative_obs = negative_obs + ${Math.trunc(delta.negativeObsDelta)}`,
    );
  }
  if (delta.weightDelta) {
    sets.push(`weight = weight + ${Number(delta.weightDelta)}`);
  }
  if (delta.classifierScore !== undefined) {
    if (delta.classifierScore === null) {
      sets.push(`classifier_score = NULL`);
    } else {
      sets.push(`classifier_score = ${Number(delta.classifierScore)}`);
    }
  }
  if (delta.conformalPvalue !== undefined) {
    if (delta.conformalPvalue === null) {
      sets.push(`conformal_pvalue = NULL`);
    } else {
      sets.push(`conformal_pvalue = ${Number(delta.conformalPvalue)}`);
    }
  }
  // Plain UPDATE via raw SQL since we want compound increments. Drizzle's
  // typed update doesn't have a column-relative increment helper that
  // composes with multiple deltas in one query.
  await db.execute(
    sql.raw(`UPDATE entity_names SET ${sets.join(", ")} WHERE id = '${id}'`),
  );
  void set;
}

export async function setEntityNameStatus(
  id: string,
  status: EntityNameStatus,
): Promise<void> {
  const setObj: Partial<EntityNameRow> = { status };
  if (status === "active") setObj.promotedAt = new Date().toISOString();
  if (status === "retired") setObj.retiredAt = new Date().toISOString();
  await db.update(entityNames).set(setObj).where(eq(entityNames.id, id));
}

export async function deleteEntityName(id: string): Promise<void> {
  await db.delete(entityNames).where(eq(entityNames.id, id));
}

// ─── Promoter / decay queries ───────────────────────────────────────────

export type CandidateRow = EntityNameRow;

/**
 * Returns all candidate rows updated since `sinceISO`. Promoter consults
 * these every tick and decides whether each can advance.
 */
export async function listRecentCandidates(
  sinceISO: string,
): Promise<CandidateRow[]> {
  return db
    .select()
    .from(entityNames)
    .where(
      and(
        eq(entityNames.status, "candidate"),
        sql`${entityNames.lastSeenAt} >= ${sinceISO}`,
      ),
    )
    .orderBy(desc(entityNames.lastSeenAt))
    .limit(500);
}

/**
 * Active rows whose last_seen is older than the cutoff. Decay sweep
 * demotes them back to candidate.
 */
export async function listStaleActiveNames(
  cutoffISO: string,
): Promise<EntityNameRow[]> {
  return db
    .select()
    .from(entityNames)
    .where(
      and(
        eq(entityNames.status, "active"),
        sql`${entityNames.lastSeenAt} < ${cutoffISO}`,
      ),
    )
    .limit(500);
}

/**
 * Competing candidates (other entity_names rows with the same
 * surface_normalized + competition_id but different entity_id). Used by
 * the promoter for conflict detection — never silently overwrite.
 */
export async function listCompetingCandidates(opts: {
  excludeId: string;
  surfaceNormalized: string;
  competitionId: string | null;
}): Promise<EntityNameRow[]> {
  return db
    .select()
    .from(entityNames)
    .where(
      and(
        sql`${entityNames.id} <> ${opts.excludeId}`,
        eq(entityNames.surfaceNormalized, opts.surfaceNormalized),
        opts.competitionId === null
          ? isNull(entityNames.competitionId)
          : eq(entityNames.competitionId, opts.competitionId),
        sql`${entityNames.status} <> 'retired'`,
      ),
    );
}

// ─── Observations (append-only) ────────────────────────────────────────

export async function insertObservation(
  row: NewNameObservationRow,
): Promise<void> {
  await db.insert(nameObservations).values(row);
}
