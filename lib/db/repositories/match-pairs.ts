/**
 * Repository for the `match_pairs` table — the ML-augmented matcher
 * pipeline's persistence layer.
 *
 * Pairs flow: inbox → human_review → history.
 * Every mutation uses atomic stage transitions to prevent races between
 * the background ML scheduler and operator actions.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql, inArray, lt } from "drizzle-orm";
import { db } from "../client";
import { matchPairs, type MatchPairRow, type NewMatchPairRow } from "../schema";
import { logger } from "../../shared/logger";

const tag = "MatchPairsRepo";

// ─── Types ─────────────────────────────────────────────────────────────

export type MatchPairStage = "inbox" | "human_review" | "history";

export type MatchPairDecision =
  | "auto-merge"
  | "auto-reject"
  | "human-merge"
  | "human-reject"
  | "ai-merge"
  | "ai-reject";

export type MatchPairDecidedBy =
  | "ml-bi-encoder"
  | "ml-cross-encoder"
  | "ai-search"
  | "human"
  | "gemini-lite"
  | "gemini-flash"
  | "gemini-pro";

export type MatchPairResolutionSource = MatchPairDecidedBy;

export type MatchPairSource = "near-match" | "unmatched-candidate";

export interface UpsertMatchPairInput {
  pairKey: string;
  source: MatchPairSource;
  stringScore: number;
  stringBreakdown?: unknown;
  eventA: {
    provider: string;
    homeTeam: string;
    awayTeam: string;
    competition: string;
    startTime: Date;
    eventId?: string;
  };
  eventB: {
    provider: string;
    homeTeam: string;
    awayTeam: string;
    competition: string;
    startTime: Date;
    eventId?: string;
  };
}

export interface MlScores {
  mlHomeCosine: number;
  mlAwayCosine: number;
  mlCompCosine: number;
  mlCombinedScore: number;
  mlModelVersion: string;
}

export interface XeScores {
  xeScore: number;
  xePvalue: number | null;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
}

// Re-export the row type
export type { MatchPairRow };

// ─── Upsert ────────────────────────────────────────────────────────────

/**
 * Insert or update by pair_key. Only updates if the new string_score is
 * better than the existing one, or the existing row is stale (>1h in
 * inbox without ML processing).
 */
export async function upsertMatchPair(
  input: UpsertMatchPairInput,
): Promise<"inserted" | "updated" | "skipped"> {
  const id = randomUUID();
  const now = new Date().toISOString();

  try {
    const rows = await db
      .insert(matchPairs)
      .values({
        id,
        stage: "inbox",
        pairKey: input.pairKey,
        source: input.source,
        stringScore: input.stringScore,
        stringBreakdown: input.stringBreakdown ?? null,
        eventAProvider: input.eventA.provider,
        eventAHomeTeam: input.eventA.homeTeam,
        eventAAwayTeam: input.eventA.awayTeam,
        eventACompetition: input.eventA.competition,
        eventAStartTime: input.eventA.startTime.toISOString(),
        eventAEventId: input.eventA.eventId ?? null,
        eventBProvider: input.eventB.provider,
        eventBHomeTeam: input.eventB.homeTeam,
        eventBAwayTeam: input.eventB.awayTeam,
        eventBCompetition: input.eventB.competition,
        eventBStartTime: input.eventB.startTime.toISOString(),
        eventBEventId: input.eventB.eventId ?? null,
        detectedAt: now,
        stageChangedAt: now,
      } satisfies NewMatchPairRow)
      .onConflictDoUpdate({
        target: matchPairs.pairKey,
        set: {
          stringScore: input.stringScore,
          stringBreakdown: input.stringBreakdown ?? null,
          eventAProvider: input.eventA.provider,
          eventAHomeTeam: input.eventA.homeTeam,
          eventAAwayTeam: input.eventA.awayTeam,
          eventACompetition: input.eventA.competition,
          eventAStartTime: input.eventA.startTime.toISOString(),
          eventAEventId: input.eventA.eventId ?? null,
          eventBProvider: input.eventB.provider,
          eventBHomeTeam: input.eventB.homeTeam,
          eventBAwayTeam: input.eventB.awayTeam,
          eventBCompetition: input.eventB.competition,
          eventBStartTime: input.eventB.startTime.toISOString(),
          eventBEventId: input.eventB.eventId ?? null,
        },
        setWhere: and(
          // Only update if still in inbox (don't overwrite ML-processed rows)
          eq(matchPairs.stage, "inbox"),
          // And only if the new score is better or existing is stale (>1h)
          sql`(${matchPairs.stringScore} < ${input.stringScore} OR ${matchPairs.stageChangedAt} < now() - interval '1 hour')`,
        ),
      })
      .returning({ id: matchPairs.id });

    if (rows.length === 0) return "skipped";
    return rows[0].id === id ? "inserted" : "updated";
  } catch (err) {
    logger.warn(tag, `upsertMatchPair failed: ${(err as Error).message}`);
    return "skipped";
  }
}

// ─── Stage transitions ─────────────────────────────────────────────────

/**
 * Atomic stage transition. Returns true if the row was in the expected
 * `from` stage and moved to `to`; false if a concurrent process already
 * moved it.
 */
export async function transitionStage(
  id: string,
  from: MatchPairStage,
  to: MatchPairStage,
): Promise<boolean> {
  const rows = await db
    .update(matchPairs)
    .set({
      stage: to,
      stageChangedAt: new Date().toISOString(),
    })
    .where(and(eq(matchPairs.id, id), eq(matchPairs.stage, from)))
    .returning({ id: matchPairs.id });
  return rows.length > 0;
}

// ─── ML score writes ───────────────────────────────────────────────────

export async function updateMlScores(
  id: string,
  scores: MlScores,
): Promise<void> {
  await db
    .update(matchPairs)
    .set({
      mlHomeCosine: scores.mlHomeCosine,
      mlAwayCosine: scores.mlAwayCosine,
      mlCompCosine: scores.mlCompCosine,
      mlCombinedScore: scores.mlCombinedScore,
      mlModelVersion: scores.mlModelVersion,
      mlScoredAt: new Date().toISOString(),
    })
    .where(eq(matchPairs.id, id));
}

export async function updateXeScores(
  id: string,
  scores: XeScores,
): Promise<void> {
  await db
    .update(matchPairs)
    .set({
      xeScore: scores.xeScore,
      xePvalue: scores.xePvalue,
      xeScoredAt: new Date().toISOString(),
    })
    .where(eq(matchPairs.id, id));
}

// ─── Decision ──────────────────────────────────────────────────────────

export async function markDecided(
  id: string,
  decision: MatchPairDecision,
  decidedBy: MatchPairDecidedBy,
  reason?: string,
): Promise<boolean> {
  const rows = await db
    .update(matchPairs)
    .set({
      decision,
      decidedBy,
      decidedAt: new Date().toISOString(),
      decisionReason: reason ?? null,
      resolutionSource: decidedBy,
      stage: "history",
      stageChangedAt: new Date().toISOString(),
    })
    .where(eq(matchPairs.id, id))
    .returning({ id: matchPairs.id });
  return rows.length > 0;
}

export async function markDecidedFromStage(
  id: string,
  from: MatchPairStage,
  decision: MatchPairDecision,
  decidedBy: MatchPairDecidedBy,
  reason?: string,
): Promise<boolean> {
  const rows = await db
    .update(matchPairs)
    .set({
      decision,
      decidedBy,
      decidedAt: new Date().toISOString(),
      decisionReason: reason ?? null,
      resolutionSource: decidedBy,
      stage: "history",
      stageChangedAt: new Date().toISOString(),
    })
    .where(and(eq(matchPairs.id, id), eq(matchPairs.stage, from)))
    .returning({ id: matchPairs.id });
  return rows.length > 0;
}

// ─── Queries ───────────────────────────────────────────────────────────

export async function listByStage(
  stage: MatchPairStage,
  opts?: ListOptions,
): Promise<MatchPairRow[]> {
  const limit = opts?.limit ?? 100;
  const offset = opts?.offset ?? 0;
  return db
    .select()
    .from(matchPairs)
    .where(eq(matchPairs.stage, stage))
    .orderBy(desc(matchPairs.detectedAt))
    .limit(limit)
    .offset(offset);
}

export async function getById(id: string): Promise<MatchPairRow | null> {
  const rows = await db
    .select()
    .from(matchPairs)
    .where(eq(matchPairs.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function getByPairKey(
  pairKey: string,
): Promise<MatchPairRow | null> {
  const rows = await db
    .select()
    .from(matchPairs)
    .where(eq(matchPairs.pairKey, pairKey))
    .limit(1);
  return rows[0] ?? null;
}

export async function getByIds(ids: string[]): Promise<MatchPairRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(matchPairs).where(inArray(matchPairs.id, ids));
}

/**
 * Per-stage counts for the stepper UI + ML health stats.
 */
export async function getStageCounts(): Promise<
  Record<MatchPairStage, number>
> {
  const rows = await db
    .select({
      stage: matchPairs.stage,
      count: sql<number>`count(*)::int`,
    })
    .from(matchPairs)
    .groupBy(matchPairs.stage);

  const counts: Record<MatchPairStage, number> = {
    inbox: 0,
    human_review: 0,
    history: 0,
  };
  for (const r of rows) {
    if (r.stage in counts) {
      counts[r.stage as MatchPairStage] = r.count;
    }
  }
  return counts;
}

export interface ResolutionSourceStat {
  source: string;
  count: number;
}

export async function getResolutionSourceStats(): Promise<
  ResolutionSourceStat[]
> {
  const sourceExpr = sql<string>`coalesce(${matchPairs.resolutionSource}, ${matchPairs.decidedBy}, 'unknown')`;
  const rows = await db
    .select({
      source: sourceExpr,
      count: sql<number>`count(*)::int`,
    })
    .from(matchPairs)
    .where(eq(matchPairs.stage, "history"))
    .groupBy(sourceExpr)
    .orderBy(sql`count(*) desc`);

  return rows.map((row) => ({
    source: row.source,
    count: row.count,
  }));
}

// ─── Cleanup ───────────────────────────────────────────────────────────

/**
 * Delete history entries older than `maxAgeDays`. Returns the number of
 * deleted rows.
 */
export async function pruneOldHistory(maxAgeDays = 30): Promise<number> {
  const cutoff = new Date(
    Date.now() - maxAgeDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const rows = await db
    .delete(matchPairs)
    .where(
      and(eq(matchPairs.stage, "history"), lt(matchPairs.decidedAt, cutoff)),
    )
    .returning({ id: matchPairs.id });
  return rows.length;
}
