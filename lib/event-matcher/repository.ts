import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  isSabaSyntheticMarketFixture,
  SABA_SYNTHETIC_MARKET_COMPETITION_SQL_RE,
  SABA_SYNTHETIC_MARKET_TEAM_SQL_RE,
} from "../adapters/saba-filters";
import { db } from "../db/client";
import { bestSim } from "../matching/string-sim";
import {
  canonicalEventMembers,
  canonicalEvents,
  type CanonicalEventRow,
  type CanonicalEventMemberRow,
  matcherCandidates,
  matcherDecisions,
  matcherImpactDaily,
  providerEventSnapshots,
  type MatcherDecisionRow,
  type NewMatcherCandidateRow,
  type NewMatcherDecisionRow,
} from "../db/schema";
import type {
  EventMatcherCandidate,
  EventMatcherClusterSummary,
  EventMatcherDecision,
  EventMatcherReliabilityStats,
  EventMatcherStage,
  EventMatcherPolicyDecision,
  ProviderEventSnapshot,
  ScoreBreakdown,
} from "./types";

export type CanonicalMergePlanAction =
  | "create"
  | "attach_a_to_b"
  | "attach_b_to_a"
  | "noop"
  | "conflict";

export interface CanonicalMergePlan {
  action: CanonicalMergePlanAction;
  canonicalEventId: string | null;
  conflictCanonicalEventIds: string[];
  memberCount: number;
  providers: string[];
}

export interface CompatibleCanonicalClusterMergePlan {
  action: "merge" | "blocked";
  canonicalEventId: string | null;
  sourceCanonicalEventIds: string[];
  reason: string;
}

interface CanonicalMemberSnapshotForPlanning {
  id: string;
  canonicalEventId: string;
  snapshotId: string;
  provider: string;
  providerEventId: string;
  sport: string;
  homeTeamRaw: string;
  awayTeamRaw: string;
  competitionRaw: string;
  parsedKickoff: string | Date;
}

const CLUSTER_MERGE_MAX_KICKOFF_DRIFT_MS = 5 * 60 * 1000;
const SABA_PROVIDER = "saba-sportsbook";

function sabaSyntheticSnapshotPredicate(table: {
  provider: unknown;
  competitionRaw: unknown;
  homeTeamRaw: unknown;
  awayTeamRaw: unknown;
}) {
  return sql`${table.provider} = ${SABA_PROVIDER} and (
    ${table.competitionRaw} ~* ${SABA_SYNTHETIC_MARKET_COMPETITION_SQL_RE}
    or ${table.homeTeamRaw} ~* ${SABA_SYNTHETIC_MARKET_TEAM_SQL_RE}
    or ${table.awayTeamRaw} ~* ${SABA_SYNTHETIC_MARKET_TEAM_SQL_RE}
  )`;
}

function nonSabaSyntheticSnapshotPredicate(table: {
  provider: unknown;
  competitionRaw: unknown;
  homeTeamRaw: unknown;
  awayTeamRaw: unknown;
}) {
  return sql`not (${sabaSyntheticSnapshotPredicate(table)})`;
}

function isSyntheticPlanningMember(
  member: Pick<
    CanonicalMemberSnapshotForPlanning,
    "provider" | "homeTeamRaw" | "awayTeamRaw" | "competitionRaw"
  >,
): boolean {
  return isSabaSyntheticMarketFixture({
    provider: member.provider,
    homeTeam: member.homeTeamRaw,
    awayTeam: member.awayTeamRaw,
    competition: member.competitionRaw,
  });
}

function rowToSnapshot(
  row: typeof providerEventSnapshots.$inferSelect,
): ProviderEventSnapshot {
  return {
    id: row.id,
    provider: row.provider,
    providerEventId: row.providerEventId,
    sport: row.sport,
    homeTeamRaw: row.homeTeamRaw,
    awayTeamRaw: row.awayTeamRaw,
    competitionRaw: row.competitionRaw,
    homeTeamNormalized: row.homeTeamNormalized,
    awayTeamNormalized: row.awayTeamNormalized,
    competitionNormalized: row.competitionNormalized,
    rawStartTime: row.rawStartTime,
    parsedKickoff: new Date(row.parsedKickoff),
    parseStrategy: row.parseStrategy,
    fetchBatchId: row.fetchBatchId,
    providerMetadata:
      (row.providerMetadata as Record<string, unknown> | null) ?? null,
    rawPayload: row.rawPayload,
    capturedAt: new Date(row.capturedAt),
  };
}

export async function loadRecentSnapshots(opts: {
  fetchBatchId?: string;
}): Promise<ProviderEventSnapshot[]> {
  const where = opts.fetchBatchId
    ? and(
        eq(providerEventSnapshots.fetchBatchId, opts.fetchBatchId),
        nonSabaSyntheticSnapshotPredicate(providerEventSnapshots),
      )
    : nonSabaSyntheticSnapshotPredicate(providerEventSnapshots);
  const rows = await db
    .select()
    .from(providerEventSnapshots)
    .where(where)
    .orderBy(desc(providerEventSnapshots.capturedAt));
  return rows.map(rowToSnapshot);
}

export async function loadSnapshotsForDecisionIds(
  decisionIds: string[],
): Promise<ProviderEventSnapshot[]> {
  if (decisionIds.length === 0) return [];
  const uniqueDecisionIds = [...new Set(decisionIds)];
  const rows = await db
    .select({
      snapshotA: matcherCandidates.snapshotAId,
      snapshotB: matcherCandidates.snapshotBId,
    })
    .from(matcherDecisions)
    .innerJoin(
      matcherCandidates,
      eq(matcherCandidates.id, matcherDecisions.candidateId),
    )
    .where(inArray(matcherDecisions.id, uniqueDecisionIds));

  const snapshotIds = [
    ...new Set(rows.flatMap((row) => [row.snapshotA, row.snapshotB])),
  ];
  if (snapshotIds.length === 0) return [];

  const snapshots = await db
    .select()
    .from(providerEventSnapshots)
    .where(
      and(
        inArray(providerEventSnapshots.id, snapshotIds),
        nonSabaSyntheticSnapshotPredicate(providerEventSnapshots),
      ),
    );
  return snapshots.map(rowToSnapshot);
}

export async function listDecisionRows(opts?: {
  runId?: string;
  decisionId?: string;
  decision?: string;
  limit?: number;
  offset?: number;
}) {
  const snapshotA = alias(providerEventSnapshots, "snapshot_a");
  const snapshotB = alias(providerEventSnapshots, "snapshot_b");
  const limit = opts?.limit ?? 200;
  const offset = opts?.offset ?? 0;
  const filters = [
    opts?.decisionId ? eq(matcherDecisions.id, opts.decisionId) : undefined,
    opts?.runId ? eq(matcherDecisions.runId, opts.runId) : undefined,
    opts?.decision ? eq(matcherDecisions.decision, opts.decision) : undefined,
    nonSabaSyntheticSnapshotPredicate(snapshotA),
    nonSabaSyntheticSnapshotPredicate(snapshotB),
    !opts?.decisionId && !opts?.runId
      ? sql`${matcherDecisions.id} in (
          select distinct on (candidate_id) id
          from matcher_decisions
          order by candidate_id, created_at desc
        )`
      : undefined,
  ].filter(Boolean);

  return db
    .select({
      decisionId: matcherDecisions.id,
      runId: matcherDecisions.runId,
      candidateId: matcherDecisions.candidateId,
      shapeFingerprint: matcherCandidates.shapeFingerprint,
      scoringVersion: matcherCandidates.scoringVersion,
      groundingVersion: matcherCandidates.groundingVersion,
      decision: matcherDecisions.decision,
      decisionStage: matcherDecisions.decisionStage,
      confidence: matcherDecisions.confidence,
      confidenceBand: matcherDecisions.confidenceBand,
      final: matcherDecisions.final,
      dryRun: matcherDecisions.dryRun,
      reasonCode: matcherDecisions.reasonCode,
      reasonSummary: matcherDecisions.reasonSummary,
      groundedDecision: matcherDecisions.groundedDecision,
      groundedConfidence: matcherDecisions.groundedConfidence,
      hardBlockers: matcherDecisions.hardBlockers,
      scoreBreakdown: matcherDecisions.scoreBreakdown,
      canonicalEventId: matcherDecisions.canonicalEventId,
      createdAt: matcherDecisions.createdAt,
      providerA: matcherCandidates.providerA,
      providerB: matcherCandidates.providerB,
      candidateKey: matcherCandidates.candidateKey,
      sourceStage: matcherCandidates.sourceStage,
      combinedScore: matcherCandidates.combinedScore,
      eventA: {
        id: snapshotA.id,
        provider: snapshotA.provider,
        providerEventId: snapshotA.providerEventId,
        homeTeam: snapshotA.homeTeamRaw,
        awayTeam: snapshotA.awayTeamRaw,
        competition: snapshotA.competitionRaw,
        kickoff: snapshotA.parsedKickoff,
        rawStartTime: snapshotA.rawStartTime,
        parseStrategy: snapshotA.parseStrategy,
        providerMetadata: snapshotA.providerMetadata,
      },
      eventB: {
        id: snapshotB.id,
        provider: snapshotB.provider,
        providerEventId: snapshotB.providerEventId,
        homeTeam: snapshotB.homeTeamRaw,
        awayTeam: snapshotB.awayTeamRaw,
        competition: snapshotB.competitionRaw,
        kickoff: snapshotB.parsedKickoff,
        rawStartTime: snapshotB.rawStartTime,
        parseStrategy: snapshotB.parseStrategy,
        providerMetadata: snapshotB.providerMetadata,
      },
      cluster: sql<{
        memberCount: number;
        providers: string[];
        canonicalEventIds: string[];
        kickoff: string | null;
        competitionVariants: string[];
        eventACanonicalEventIds: string[];
        eventBCanonicalEventIds: string[];
        conflictCanonicalEventIds: string[];
      } | null>`(
        SELECT jsonb_build_object(
          'memberCount', coalesce((
            SELECT count(cem_all.id)::int
            FROM canonical_event_members cem_all
            WHERE cem_all.canonical_event_id IN (
              SELECT cem_self.canonical_event_id
              FROM canonical_event_members cem_self
              WHERE cem_self.snapshot_id IN (${snapshotA.id}, ${snapshotB.id})
            )
          ), 0),
          'providers', coalesce((
            SELECT jsonb_agg(distinct cem_all.provider) FILTER (WHERE cem_all.provider IS NOT NULL)
            FROM canonical_event_members cem_all
            WHERE cem_all.canonical_event_id IN (
              SELECT cem_self.canonical_event_id
              FROM canonical_event_members cem_self
              WHERE cem_self.snapshot_id IN (${snapshotA.id}, ${snapshotB.id})
            )
          ), '[]'::jsonb),
          'canonicalEventIds', coalesce((
            SELECT jsonb_agg(distinct cem_all.canonical_event_id) FILTER (WHERE cem_all.canonical_event_id IS NOT NULL)
            FROM canonical_event_members cem_all
            WHERE cem_all.canonical_event_id IN (
              SELECT cem_self.canonical_event_id
              FROM canonical_event_members cem_self
              WHERE cem_self.snapshot_id IN (${snapshotA.id}, ${snapshotB.id})
            )
          ), '[]'::jsonb),
          'kickoff', (
            SELECT min(ce.kickoff)
            FROM canonical_events ce
            WHERE ce.id IN (
              SELECT cem_self.canonical_event_id
              FROM canonical_event_members cem_self
              WHERE cem_self.snapshot_id IN (${snapshotA.id}, ${snapshotB.id})
            )
          ),
          'competitionVariants', coalesce((
            SELECT jsonb_agg(distinct ps.competition_raw) FILTER (WHERE ps.competition_raw IS NOT NULL)
            FROM canonical_event_members cem_all
            JOIN provider_event_snapshots ps
              ON ps.id = cem_all.snapshot_id
            WHERE cem_all.canonical_event_id IN (
              SELECT cem_self.canonical_event_id
              FROM canonical_event_members cem_self
              WHERE cem_self.snapshot_id IN (${snapshotA.id}, ${snapshotB.id})
            )
          ), '[]'::jsonb),
          'eventACanonicalEventIds', coalesce((
            SELECT jsonb_agg(cem_a.canonical_event_id)
            FROM canonical_event_members cem_a
            WHERE cem_a.snapshot_id = ${snapshotA.id}
          ), '[]'::jsonb),
          'eventBCanonicalEventIds', coalesce((
            SELECT jsonb_agg(cem_b.canonical_event_id)
            FROM canonical_event_members cem_b
            WHERE cem_b.snapshot_id = ${snapshotB.id}
          ), '[]'::jsonb),
          'conflictCanonicalEventIds', '[]'::jsonb
        )
      )`,
    })
    .from(matcherDecisions)
    .innerJoin(
      matcherCandidates,
      eq(matcherCandidates.id, matcherDecisions.candidateId),
    )
    .innerJoin(snapshotA, eq(snapshotA.id, matcherCandidates.snapshotAId))
    .innerJoin(snapshotB, eq(snapshotB.id, matcherCandidates.snapshotBId))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(matcherDecisions.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function countDecisionRows(opts?: {
  runId?: string;
  decisionId?: string;
  decision?: string;
}): Promise<number> {
  const snapshotA = alias(providerEventSnapshots, "count_snapshot_a");
  const snapshotB = alias(providerEventSnapshots, "count_snapshot_b");
  const filters = [
    opts?.decisionId ? eq(matcherDecisions.id, opts.decisionId) : undefined,
    opts?.runId ? eq(matcherDecisions.runId, opts.runId) : undefined,
    opts?.decision ? eq(matcherDecisions.decision, opts.decision) : undefined,
    nonSabaSyntheticSnapshotPredicate(snapshotA),
    nonSabaSyntheticSnapshotPredicate(snapshotB),
    !opts?.decisionId && !opts?.runId
      ? sql`${matcherDecisions.id} in (
          select distinct on (candidate_id) id
          from matcher_decisions
          order by candidate_id, created_at desc
        )`
      : undefined,
  ].filter(Boolean);

  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(matcherDecisions)
    .innerJoin(
      matcherCandidates,
      eq(matcherCandidates.id, matcherDecisions.candidateId),
    )
    .innerJoin(snapshotA, eq(snapshotA.id, matcherCandidates.snapshotAId))
    .innerJoin(snapshotB, eq(snapshotB.id, matcherCandidates.snapshotBId))
    .where(filters.length > 0 ? and(...filters) : undefined);
  return rows[0]?.count ?? 0;
}

export async function decisionCountsForDecisionRows(opts?: {
  runId?: string;
}): Promise<{ decision: string; count: number }[]> {
  const snapshotA = alias(providerEventSnapshots, "decision_count_snapshot_a");
  const snapshotB = alias(providerEventSnapshots, "decision_count_snapshot_b");
  const filters = [
    opts?.runId ? eq(matcherDecisions.runId, opts.runId) : undefined,
    nonSabaSyntheticSnapshotPredicate(snapshotA),
    nonSabaSyntheticSnapshotPredicate(snapshotB),
    !opts?.runId
      ? sql`${matcherDecisions.id} in (
          select distinct on (candidate_id) id
          from matcher_decisions
          order by candidate_id, created_at desc
        )`
      : undefined,
  ].filter(Boolean);

  return db
    .select({
      decision: matcherDecisions.decision,
      count: sql<number>`count(*)::int`,
    })
    .from(matcherDecisions)
    .innerJoin(
      matcherCandidates,
      eq(matcherCandidates.id, matcherDecisions.candidateId),
    )
    .innerJoin(snapshotA, eq(snapshotA.id, matcherCandidates.snapshotAId))
    .innerJoin(snapshotB, eq(snapshotB.id, matcherCandidates.snapshotBId))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .groupBy(matcherDecisions.decision)
    .orderBy(sql`count(*) desc`);
}

export async function readDecisionRow(decisionId: string) {
  const rows = await listDecisionRows({ decisionId, limit: 1 });
  return rows[0] ?? null;
}

export async function countDecisions(opts?: {
  runId?: string;
  decision?: string;
}): Promise<number> {
  const snapshotA = alias(providerEventSnapshots, "stats_count_snapshot_a");
  const snapshotB = alias(providerEventSnapshots, "stats_count_snapshot_b");
  const filters = [
    opts?.runId ? eq(matcherDecisions.runId, opts.runId) : undefined,
    opts?.decision ? eq(matcherDecisions.decision, opts.decision) : undefined,
    nonSabaSyntheticSnapshotPredicate(snapshotA),
    nonSabaSyntheticSnapshotPredicate(snapshotB),
  ].filter(Boolean);
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(matcherDecisions)
    .innerJoin(
      matcherCandidates,
      eq(matcherCandidates.id, matcherDecisions.candidateId),
    )
    .innerJoin(snapshotA, eq(snapshotA.id, matcherCandidates.snapshotAId))
    .innerJoin(snapshotB, eq(snapshotB.id, matcherCandidates.snapshotBId))
    .where(filters.length > 0 ? and(...filters) : undefined);
  return rows[0]?.count ?? 0;
}

export async function filterNewCandidateKeys(
  candidates: Array<{ candidateKey: string; shapeFingerprint: string }>,
  opts?: { includeExisting?: boolean },
): Promise<Set<string>> {
  const uniqueKeys = [...new Set(candidates.map((c) => c.candidateKey))];
  if (opts?.includeExisting) return new Set(uniqueKeys);
  if (candidates.length === 0) return new Set();
  const currentShapes = new Map<string, string>();
  for (const candidate of candidates) {
    currentShapes.set(candidate.candidateKey, candidate.shapeFingerprint);
  }
  const unchanged = new Set<string>();
  const batchSize = 1000;

  for (let i = 0; i < uniqueKeys.length; i += batchSize) {
    const rows = await db
      .select({
        candidateKey: matcherCandidates.candidateKey,
        shapeFingerprint: matcherCandidates.shapeFingerprint,
      })
      .from(matcherCandidates)
      .where(
        inArray(
          matcherCandidates.candidateKey,
          uniqueKeys.slice(i, i + batchSize),
        ),
      );
    for (const row of rows) {
      if (currentShapes.get(row.candidateKey) === row.shapeFingerprint) {
        unchanged.add(row.candidateKey);
      }
    }
  }

  return new Set(uniqueKeys.filter((key) => !unchanged.has(key)));
}

export async function decisionCountsByDecision(): Promise<
  { decision: string; count: number }[]
> {
  const snapshotA = alias(providerEventSnapshots, "stats_decision_snapshot_a");
  const snapshotB = alias(providerEventSnapshots, "stats_decision_snapshot_b");
  return db
    .select({
      decision: matcherDecisions.decision,
      count: sql<number>`count(*)::int`,
    })
    .from(matcherDecisions)
    .innerJoin(
      matcherCandidates,
      eq(matcherCandidates.id, matcherDecisions.candidateId),
    )
    .innerJoin(snapshotA, eq(snapshotA.id, matcherCandidates.snapshotAId))
    .innerJoin(snapshotB, eq(snapshotB.id, matcherCandidates.snapshotBId))
    .where(
      and(
        nonSabaSyntheticSnapshotPredicate(snapshotA),
        nonSabaSyntheticSnapshotPredicate(snapshotB),
      ),
    )
    .groupBy(matcherDecisions.decision)
    .orderBy(sql`count(*) desc`);
}

const GROUNDED_REVIEW_SKIP_REASON_CODES = new Set([
  "grounded_review_disabled",
  "grounded_review_degraded",
  "grounded_review_cap_reached",
]);

export async function readReliabilityStats(
  limit = 500,
): Promise<EventMatcherReliabilityStats> {
  const snapshotA = alias(providerEventSnapshots, "reliability_snapshot_a");
  const snapshotB = alias(providerEventSnapshots, "reliability_snapshot_b");
  const rows = await db
    .select({
      decision: matcherDecisions.decision,
      decisionStage: matcherDecisions.decisionStage,
      reasonCode: matcherDecisions.reasonCode,
    })
    .from(matcherDecisions)
    .innerJoin(
      matcherCandidates,
      eq(matcherCandidates.id, matcherDecisions.candidateId),
    )
    .innerJoin(snapshotA, eq(snapshotA.id, matcherCandidates.snapshotAId))
    .innerJoin(snapshotB, eq(snapshotB.id, matcherCandidates.snapshotBId))
    .where(
      and(
        nonSabaSyntheticSnapshotPredicate(snapshotA),
        nonSabaSyntheticSnapshotPredicate(snapshotB),
      ),
    )
    .orderBy(desc(matcherDecisions.createdAt))
    .limit(limit);

  let deepseekReviewed = 0;
  let deepseekResolved = 0;
  let deepseekUnavailable = 0;
  let groundedReviewSkipped = 0;
  let groundedReviewDisabled = 0;
  let groundedReviewDegraded = 0;
  let groundedReviewCapReached = 0;
  let searchFailure = 0;
  let noSource = 0;
  let contradictorySource = 0;
  let uncertain = 0;
  let autoMerge = 0;
  let autoReject = 0;
  let humanFallback = 0;
  let clusterConflicts = 0;

  for (const row of rows) {
    if (row.decision === "auto_merge") autoMerge++;
    if (row.decision === "auto_reject") autoReject++;
    if (row.decision === "human_review") humanFallback++;
    if (row.reasonCode === "cluster_conflict") clusterConflicts++;
    if (GROUNDED_REVIEW_SKIP_REASON_CODES.has(row.reasonCode)) {
      groundedReviewSkipped++;
      if (row.reasonCode === "grounded_review_disabled") {
        groundedReviewDisabled++;
      }
      if (row.reasonCode === "grounded_review_degraded") {
        groundedReviewDegraded++;
      }
      if (row.reasonCode === "grounded_review_cap_reached") {
        groundedReviewCapReached++;
      }
      continue;
    }

    const touchedDeepSeek =
      row.decisionStage === "deepseek" ||
      row.reasonCode.startsWith("grounded_llm_") ||
      row.reasonCode === "llm_uncertain" ||
      row.reasonCode === "llm_evidence_conflict" ||
      row.reasonCode === "llm_no_source" ||
      row.reasonCode === "llm_search_failure" ||
      row.reasonCode === "deepseek_unavailable";
    if (!touchedDeepSeek) continue;

    deepseekReviewed++;
    if (row.reasonCode.startsWith("grounded_llm_")) deepseekResolved++;
    if (row.reasonCode === "deepseek_unavailable") deepseekUnavailable++;
    if (row.reasonCode === "llm_uncertain") uncertain++;
    if (row.reasonCode === "llm_evidence_conflict") contradictorySource++;
    if (row.reasonCode === "llm_no_source") noSource++;
    if (row.reasonCode === "llm_search_failure") searchFailure++;
  }

  const noSourceRate =
    deepseekReviewed > 0 ? Number((noSource / deepseekReviewed).toFixed(3)) : 0;
  const searchFailureRate =
    deepseekReviewed > 0
      ? Number((searchFailure / deepseekReviewed).toFixed(3))
      : 0;
  const unavailableRate =
    deepseekReviewed > 0
      ? Number((deepseekUnavailable / deepseekReviewed).toFixed(3))
      : 0;
  const contradictorySourceRate =
    deepseekReviewed > 0
      ? Number((contradictorySource / deepseekReviewed).toFixed(3))
      : 0;
  const humanFallbackRate =
    rows.length > 0 ? Number((humanFallback / rows.length).toFixed(3)) : 0;
  let degradationReason: string | null = null;
  if (deepseekReviewed >= 5 && unavailableRate >= 0.5) {
    degradationReason = "DeepSeek unavailable rate is high";
  } else if (deepseekReviewed >= 5 && searchFailureRate >= 0.5) {
    degradationReason = "Search failure rate is high";
  } else if (deepseekReviewed >= 5 && noSourceRate >= 0.5) {
    degradationReason = "Grounded review returned too many no-source decisions";
  } else if (deepseekReviewed >= 5 && contradictorySourceRate >= 0.3) {
    degradationReason = "DeepSeek decisions have too many conflicts";
  }

  return {
    windowSize: rows.length,
    deepseekReviewed,
    deepseekResolved,
    deepseekUnavailable,
    groundedReviewSkipped,
    groundedReviewDisabled,
    groundedReviewDegraded,
    groundedReviewCapReached,
    searchFailure,
    noSource,
    contradictorySource,
    uncertain,
    autoMerge,
    autoReject,
    humanFallback,
    clusterConflicts,
    noSourceRate,
    searchFailureRate,
    unavailableRate,
    contradictorySourceRate,
    humanFallbackRate,
    healthy: degradationReason === null,
    degradationReason,
  };
}

export async function markManualDecision(input: {
  decisionId: string;
  decision: Extract<
    EventMatcherDecision,
    "auto_merge" | "auto_reject" | "human_review"
  >;
  reason?: string | null;
}): Promise<boolean> {
  const reasonSummary =
    input.reason?.trim() ||
    (input.decision === "auto_merge"
      ? "Operator confirmed these provider events are the same match."
      : input.decision === "auto_reject"
        ? "Operator rejected this candidate as a different match."
        : "Operator kept this candidate in manual review.");
  const existingRows = await db
    .select()
    .from(matcherDecisions)
    .where(eq(matcherDecisions.id, input.decisionId))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) return false;

  if (input.decision !== "auto_merge" && existing.canonicalEventId) {
    await db.transaction(async (tx) => {
      await tx
        .delete(canonicalEventMembers)
        .where(eq(canonicalEventMembers.decisionId, input.decisionId));
      await tx.delete(canonicalEvents).where(
        and(
          eq(canonicalEvents.id, existing.canonicalEventId!),
          sql`not exists (
              select 1
              from canonical_event_members cem
              where cem.canonical_event_id = ${existing.canonicalEventId}
            )`,
        ),
      );
    });
  }

  const rows = await db
    .update(matcherDecisions)
    .set({
      decision: input.decision,
      decisionStage: "human_review" satisfies EventMatcherStage,
      confidence: 1,
      confidenceBand: "very_high",
      final: input.decision !== "human_review",
      reasonCode:
        input.decision === "auto_merge"
          ? "manual_match"
          : input.decision === "auto_reject"
            ? "manual_reject"
            : "manual_review",
      reasonSummary,
      canonicalEventId:
        input.decision === "auto_merge" ? existing.canonicalEventId : null,
    })
    .where(eq(matcherDecisions.id, input.decisionId))
    .returning();
  const decision = rows[0];
  if (decision && input.decision === "auto_merge") {
    const candidateRows = await db
      .select()
      .from(matcherCandidates)
      .where(eq(matcherCandidates.id, decision.candidateId))
      .limit(1);
    const candidateRow = candidateRows[0];
    if (candidateRow) {
      const snapshotRows = await db
        .select()
        .from(providerEventSnapshots)
        .where(
          inArray(providerEventSnapshots.id, [
            candidateRow.snapshotAId,
            candidateRow.snapshotBId,
          ]),
        );
      const a = snapshotRows.find((row) => row.id === candidateRow.snapshotAId);
      const b = snapshotRows.find((row) => row.id === candidateRow.snapshotBId);
      if (a && b) {
        await applyCanonicalMerge({
          candidate: {
            id: candidateRow.id,
            runId: candidateRow.runId,
            snapshotA: rowToSnapshot(a),
            snapshotB: rowToSnapshot(b),
            candidateKey: candidateRow.candidateKey,
            shapeFingerprint: candidateRow.shapeFingerprint,
            scoringVersion: candidateRow.scoringVersion,
            groundingVersion: candidateRow.groundingVersion,
            hardBlockers: Array.isArray(candidateRow.hardBlockers)
              ? (candidateRow.hardBlockers as string[])
              : [],
            reasons: [],
            admission: "hard_admit",
            sourceStage: candidateRow.sourceStage,
          },
          decision,
        });
      }
    }
  }
  return Boolean(decision);
}

export async function insertCandidate(
  candidate: EventMatcherCandidate,
  score?: ScoreBreakdown,
): Promise<boolean> {
  const row = {
    id: candidate.id,
    runId: candidate.runId,
    snapshotAId: candidate.snapshotA.id,
    snapshotBId: candidate.snapshotB.id,
    providerA: candidate.snapshotA.provider,
    providerB: candidate.snapshotB.provider,
    candidateKey: candidate.candidateKey,
    shapeFingerprint: candidate.shapeFingerprint,
    scoringVersion: candidate.scoringVersion,
    groundingVersion: candidate.groundingVersion,
    status: candidate.hardBlockers.length > 0 ? "blocked" : "scored",
    hardBlockers: candidate.hardBlockers,
    reasons: [],
    scoreBreakdown: score ?? null,
    combinedScore: score?.combined ?? null,
    sourceStage: candidate.sourceStage,
  } satisfies NewMatcherCandidateRow;

  const inserted = await db
    .insert(matcherCandidates)
    .values(row)
    .onConflictDoUpdate({
      target: matcherCandidates.candidateKey,
      set: {
        runId: candidate.runId,
        snapshotAId: candidate.snapshotA.id,
        snapshotBId: candidate.snapshotB.id,
        providerA: candidate.snapshotA.provider,
        providerB: candidate.snapshotB.provider,
        shapeFingerprint: candidate.shapeFingerprint,
        scoringVersion: candidate.scoringVersion,
        groundingVersion: candidate.groundingVersion,
        status: candidate.hardBlockers.length > 0 ? "blocked" : "scored",
        hardBlockers: candidate.hardBlockers,
        reasons: [],
        scoreBreakdown: score ?? null,
        combinedScore: score?.combined ?? null,
        sourceStage: candidate.sourceStage,
      },
    })
    .returning({ id: matcherCandidates.id });
  if (inserted.length > 0) {
    candidate.id = inserted[0].id;
    return true;
  }

  const candidateRows = await db
    .select({ id: matcherCandidates.id })
    .from(matcherCandidates)
    .where(eq(matcherCandidates.candidateKey, candidate.candidateKey))
    .limit(1);
  const existing = candidateRows[0];
  if (!existing) return false;

  candidate.id = existing.id;
  return true;
}

export async function insertDecision(input: {
  candidate: EventMatcherCandidate;
  policy: EventMatcherPolicyDecision;
  score: ScoreBreakdown;
}): Promise<MatcherDecisionRow> {
  const row: NewMatcherDecisionRow = {
    id: randomUUID(),
    runId: input.candidate.runId,
    candidateId: input.candidate.id,
    decision: input.policy.decision,
    decisionStage: input.policy.stage,
    confidence: input.policy.confidence,
    confidenceBand: input.policy.confidenceBand,
    final: input.policy.final,
    dryRun: false,
    reasonCode: input.policy.reasonCode,
    reasonSummary: input.policy.reasonSummary.slice(0, 2000),
    groundedDecision: input.policy.groundedDecision ?? null,
    groundedConfidence: input.policy.groundedConfidence ?? null,
    hardBlockers: input.candidate.hardBlockers,
    scoreBreakdown: input.score,
    canonicalEventId: null,
  };
  const inserted = await db.insert(matcherDecisions).values(row).returning();
  return inserted[0];
}

export async function supersedeStaleHumanReviewDecisions(input: {
  decisionIds: string[];
  runId: string;
  generatedCandidateKeys: Set<string>;
}): Promise<number> {
  const uniqueDecisionIds = [...new Set(input.decisionIds)].filter(Boolean);
  if (uniqueDecisionIds.length === 0) return 0;

  const rows = await db
    .select({
      decisionId: matcherDecisions.id,
      decision: matcherDecisions.decision,
      candidateId: matcherDecisions.candidateId,
      candidateKey: matcherCandidates.candidateKey,
      scoreBreakdown: matcherDecisions.scoreBreakdown,
    })
    .from(matcherDecisions)
    .innerJoin(
      matcherCandidates,
      eq(matcherCandidates.id, matcherDecisions.candidateId),
    )
    .where(inArray(matcherDecisions.id, uniqueDecisionIds));

  const staleRows = rows.filter(
    (row) =>
      row.decision === "human_review" &&
      !input.generatedCandidateKeys.has(row.candidateKey),
  );
  if (staleRows.length === 0) return 0;

  const inserted = await db
    .insert(matcherDecisions)
    .values(
      staleRows.map(
        (row): NewMatcherDecisionRow => ({
          id: randomUUID(),
          runId: input.runId,
          candidateId: row.candidateId,
          decision: "auto_reject",
          decisionStage: "deterministic",
          confidence: 1,
          confidenceBand: "very_high",
          final: true,
          dryRun: false,
          reasonCode: "stale_candidate_not_regenerated",
          reasonSummary:
            "Selected review row no longer forms an admissible current candidate, so the stale review decision was superseded.",
          hardBlockers: ["stale_candidate_not_regenerated"],
          scoreBreakdown: row.scoreBreakdown,
          groundedDecision: null,
          groundedConfidence: null,
          canonicalEventId: null,
        }),
      ),
    )
    .returning({ id: matcherDecisions.id });

  return inserted.length;
}

export interface ClusterResolvedReviewSupersedeResult {
  superseded: number;
  currentRunSuperseded: number;
}

export async function supersedeClusterResolvedHumanReviewDecisions(input: {
  runId: string;
}): Promise<ClusterResolvedReviewSupersedeResult> {
  const memberA = alias(canonicalEventMembers, "cluster_member_a");
  const memberB = alias(canonicalEventMembers, "cluster_member_b");
  const rows = await db
    .select({
      previousRunId: matcherDecisions.runId,
      candidateId: matcherDecisions.candidateId,
      scoreBreakdown: matcherDecisions.scoreBreakdown,
      hardBlockers: matcherDecisions.hardBlockers,
      groundedDecision: matcherDecisions.groundedDecision,
      groundedConfidence: matcherDecisions.groundedConfidence,
      canonicalEventId: memberA.canonicalEventId,
    })
    .from(matcherDecisions)
    .innerJoin(
      matcherCandidates,
      eq(matcherCandidates.id, matcherDecisions.candidateId),
    )
    .innerJoin(memberA, eq(memberA.snapshotId, matcherCandidates.snapshotAId))
    .innerJoin(
      memberB,
      and(
        eq(memberB.snapshotId, matcherCandidates.snapshotBId),
        eq(memberB.canonicalEventId, memberA.canonicalEventId),
      ),
    )
    .innerJoin(
      canonicalEvents,
      and(
        eq(canonicalEvents.id, memberA.canonicalEventId),
        eq(canonicalEvents.status, "active"),
      ),
    )
    .where(
      and(
        eq(matcherDecisions.decision, "human_review"),
        sql`${matcherDecisions.id} in (
          select distinct on (candidate_id) id
          from matcher_decisions
          order by candidate_id, created_at desc
        )`,
        sql`coalesce(jsonb_array_length(${matcherDecisions.hardBlockers}), 0) = 0`,
        sql`${matcherDecisions.reasonCode} not in ('manual_review', 'cluster_conflict')`,
      ),
    );

  if (rows.length === 0) {
    return { superseded: 0, currentRunSuperseded: 0 };
  }

  const inserted = await db
    .insert(matcherDecisions)
    .values(
      rows.map(
        (row): NewMatcherDecisionRow => ({
          id: randomUUID(),
          runId: input.runId,
          candidateId: row.candidateId,
          decision: "auto_merge",
          decisionStage: "deterministic",
          confidence: 1,
          confidenceBand: "very_high",
          final: true,
          dryRun: false,
          reasonCode: "canonical_cluster_already_matched",
          reasonSummary: `Both provider snapshots are already members of canonical event ${row.canonicalEventId}, so the stale review row was superseded.`,
          hardBlockers: row.hardBlockers,
          scoreBreakdown: row.scoreBreakdown,
          groundedDecision: row.groundedDecision,
          groundedConfidence: row.groundedConfidence,
          canonicalEventId: row.canonicalEventId,
        }),
      ),
    )
    .returning({ id: matcherDecisions.id });

  return {
    superseded: inserted.length,
    currentRunSuperseded: rows.filter(
      (row) => row.previousRunId === input.runId,
    ).length,
  };
}

async function loadMembersForSnapshots(
  snapshotIds: string[],
): Promise<CanonicalEventMemberRow[]> {
  if (snapshotIds.length === 0) return [];
  return db
    .select()
    .from(canonicalEventMembers)
    .where(inArray(canonicalEventMembers.snapshotId, snapshotIds));
}

function canonicalHome(candidate: EventMatcherCandidate): string {
  return candidate.snapshotA.homeTeamRaw || candidate.snapshotB.homeTeamRaw;
}

function canonicalAway(candidate: EventMatcherCandidate): string {
  return candidate.snapshotA.awayTeamRaw || candidate.snapshotB.awayTeamRaw;
}

function canonicalCompetition(candidate: EventMatcherCandidate): string {
  return (
    candidate.snapshotA.competitionRaw || candidate.snapshotB.competitionRaw
  );
}

function normalizeClusterSurface(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(fc|sc|cf|ac|as|club)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function allSurfacesCompatible(values: string[], threshold: number): boolean {
  const surfaces = values.map(normalizeClusterSurface).filter(Boolean);
  for (let i = 0; i < surfaces.length; i++) {
    for (let j = i + 1; j < surfaces.length; j++) {
      if (bestSim(surfaces[i], surfaces[j]) < threshold) return false;
    }
  }
  return true;
}

function scoreSupportsCompatibleClusterMerge(score: ScoreBreakdown): boolean {
  const alignedTeam =
    score.orientation === "same"
      ? Math.min(score.home, score.away)
      : Math.min(score.swappedHome, score.swappedAway);
  const competitionConsensus = Math.max(
    score.competition,
    score.embeddingCompetition ?? 0,
  );
  const teamConsensus = Math.max(score.bestTeam, score.embeddingTeam ?? 0);

  return (
    score.kickoffExact &&
    score.orientation === "same" &&
    score.combined >= 0.91 &&
    alignedTeam >= 0.96 &&
    score.bestTeam >= 0.98 &&
    teamConsensus >= 0.96 &&
    competitionConsensus >= 0.82
  );
}

function clusterMembersHaveNoProviderCollision(
  members: Array<
    Pick<CanonicalMemberSnapshotForPlanning, "provider" | "canonicalEventId">
  >,
): boolean {
  const providerCanonicalIds = new Map<string, string>();
  for (const member of members) {
    const existing = providerCanonicalIds.get(member.provider);
    if (existing && existing !== member.canonicalEventId) return false;
    providerCanonicalIds.set(member.provider, member.canonicalEventId);
  }
  return true;
}

function chooseTargetCanonicalEvent(
  events: CanonicalEventRow[],
  members: CanonicalMemberSnapshotForPlanning[] = [],
): string {
  const eligibleMemberCounts = new Map<string, number>();
  for (const member of members) {
    eligibleMemberCounts.set(
      member.canonicalEventId,
      (eligibleMemberCounts.get(member.canonicalEventId) ?? 0) + 1,
    );
  }

  return [...events].sort((a, b) => {
    const memberCountDelta =
      (eligibleMemberCounts.get(b.id) ?? 0) -
      (eligibleMemberCounts.get(a.id) ?? 0);
    if (memberCountDelta !== 0) return memberCountDelta;

    const kickoffDelta =
      new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime();
    if (kickoffDelta !== 0) return kickoffDelta;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  })[0].id;
}

export async function planCompatibleCanonicalClusterMerge(input: {
  conflictCanonicalEventIds: string[];
  score: ScoreBreakdown;
}): Promise<CompatibleCanonicalClusterMergePlan> {
  const conflictCanonicalEventIds = [
    ...new Set(input.conflictCanonicalEventIds),
  ];
  if (conflictCanonicalEventIds.length < 2) {
    return {
      action: "blocked",
      canonicalEventId: null,
      sourceCanonicalEventIds: [],
      reason: "No conflicting canonical clusters were provided.",
    };
  }
  if (!scoreSupportsCompatibleClusterMerge(input.score)) {
    return {
      action: "blocked",
      canonicalEventId: null,
      sourceCanonicalEventIds: [],
      reason:
        "Candidate score is not strong enough to merge canonical clusters.",
    };
  }

  const events = await db
    .select()
    .from(canonicalEvents)
    .where(inArray(canonicalEvents.id, conflictCanonicalEventIds));
  if (
    events.length !== conflictCanonicalEventIds.length ||
    events.some((event) => event.status !== "active")
  ) {
    return {
      action: "blocked",
      canonicalEventId: null,
      sourceCanonicalEventIds: [],
      reason:
        "One or more conflicting canonical clusters are missing or inactive.",
    };
  }

  const memberRows = await db
    .select({
      id: canonicalEventMembers.id,
      canonicalEventId: canonicalEventMembers.canonicalEventId,
      snapshotId: canonicalEventMembers.snapshotId,
      provider: canonicalEventMembers.provider,
      providerEventId: canonicalEventMembers.providerEventId,
      sport: providerEventSnapshots.sport,
      homeTeamRaw: providerEventSnapshots.homeTeamRaw,
      awayTeamRaw: providerEventSnapshots.awayTeamRaw,
      competitionRaw: providerEventSnapshots.competitionRaw,
      parsedKickoff: providerEventSnapshots.parsedKickoff,
    })
    .from(canonicalEventMembers)
    .innerJoin(
      providerEventSnapshots,
      eq(providerEventSnapshots.id, canonicalEventMembers.snapshotId),
    )
    .where(
      inArray(
        canonicalEventMembers.canonicalEventId,
        conflictCanonicalEventIds,
      ),
    );
  const compatibilityMembers = memberRows.filter(
    (member) => !isSyntheticPlanningMember(member),
  );
  const compatibilityCanonicalIds = new Set(
    compatibilityMembers.map((member) => member.canonicalEventId),
  );
  if (
    conflictCanonicalEventIds.some((id) => !compatibilityCanonicalIds.has(id))
  ) {
    return {
      action: "blocked",
      canonicalEventId: null,
      sourceCanonicalEventIds: [],
      reason:
        "One or more conflicting canonical clusters have no non-synthetic members for compatibility checks.",
    };
  }

  if (!clusterMembersHaveNoProviderCollision(compatibilityMembers)) {
    return {
      action: "blocked",
      canonicalEventId: null,
      sourceCanonicalEventIds: [],
      reason:
        "Conflicting canonical clusters contain different non-synthetic events from the same provider.",
    };
  }

  const sports = new Set(events.map((event) => event.sport));
  if (sports.size !== 1) {
    return {
      action: "blocked",
      canonicalEventId: null,
      sourceCanonicalEventIds: [],
      reason: "Conflicting canonical clusters are for different sports.",
    };
  }

  const kickoffs = events.map((event) => new Date(event.kickoff).getTime());
  const kickoffDrift = Math.max(...kickoffs) - Math.min(...kickoffs);
  if (kickoffDrift > CLUSTER_MERGE_MAX_KICKOFF_DRIFT_MS) {
    return {
      action: "blocked",
      canonicalEventId: null,
      sourceCanonicalEventIds: [],
      reason:
        "Conflicting canonical clusters have materially different kickoffs.",
    };
  }

  if (
    !allSurfacesCompatible(
      compatibilityMembers.map((member) => member.homeTeamRaw),
      0.82,
    ) ||
    !allSurfacesCompatible(
      compatibilityMembers.map((member) => member.awayTeamRaw),
      0.82,
    )
  ) {
    return {
      action: "blocked",
      canonicalEventId: null,
      sourceCanonicalEventIds: [],
      reason: "Canonical cluster team surfaces are not compatible.",
    };
  }

  const targetCanonicalEventId = chooseTargetCanonicalEvent(
    events,
    compatibilityMembers,
  );
  return {
    action: "merge",
    canonicalEventId: targetCanonicalEventId,
    sourceCanonicalEventIds: conflictCanonicalEventIds.filter(
      (id) => id !== targetCanonicalEventId,
    ),
    reason:
      "Conflicting canonical clusters have compatible teams, sport, kickoff, providers, and score evidence.",
  };
}

export async function planCanonicalMerge(
  candidate: EventMatcherCandidate,
): Promise<CanonicalMergePlan> {
  const aId = candidate.snapshotA.id;
  const bId = candidate.snapshotB.id;
  const members = await loadMembersForSnapshots([aId, bId]);
  const aMember = members.find((member) => member.snapshotId === aId);
  const bMember = members.find((member) => member.snapshotId === bId);
  const memberCanonicalIds = [
    ...new Set(members.map((member) => member.canonicalEventId)),
  ];
  const providers = [...new Set(members.map((member) => member.provider))];

  if (!aMember && !bMember) {
    return {
      action: "create",
      canonicalEventId: null,
      conflictCanonicalEventIds: [],
      memberCount: 0,
      providers: [],
    };
  }

  if (aMember && !bMember) {
    return {
      action: "attach_b_to_a",
      canonicalEventId: aMember.canonicalEventId,
      conflictCanonicalEventIds: [],
      memberCount: members.length,
      providers,
    };
  }

  if (!aMember && bMember) {
    return {
      action: "attach_a_to_b",
      canonicalEventId: bMember.canonicalEventId,
      conflictCanonicalEventIds: [],
      memberCount: members.length,
      providers,
    };
  }

  if (aMember?.canonicalEventId === bMember?.canonicalEventId) {
    return {
      action: "noop",
      canonicalEventId: aMember?.canonicalEventId ?? null,
      conflictCanonicalEventIds: [],
      memberCount: members.length,
      providers,
    };
  }

  return {
    action: "conflict",
    canonicalEventId: null,
    conflictCanonicalEventIds: memberCanonicalIds,
    memberCount: members.length,
    providers,
  };
}

export async function applyCanonicalMerge(input: {
  candidate: EventMatcherCandidate;
  decision: MatcherDecisionRow;
}): Promise<string> {
  const a = input.candidate.snapshotA;
  const b = input.candidate.snapshotB;
  if (a.parsedKickoff.getTime() !== b.parsedKickoff.getTime()) {
    throw new Error("Cannot merge provider snapshots with different kickoffs");
  }

  return db.transaction(async (tx) => {
    const members = await tx
      .select()
      .from(canonicalEventMembers)
      .where(inArray(canonicalEventMembers.snapshotId, [a.id, b.id]));
    const aMember = members.find((member) => member.snapshotId === a.id);
    const bMember = members.find((member) => member.snapshotId === b.id);
    const conflictIds = [
      ...new Set(members.map((member) => member.canonicalEventId)),
    ];

    if (
      aMember &&
      bMember &&
      aMember.canonicalEventId !== bMember.canonicalEventId
    ) {
      await tx
        .update(matcherDecisions)
        .set({
          decision: "human_review",
          decisionStage: "human_review",
          final: false,
          reasonCode: "cluster_conflict",
          reasonSummary: `Canonical cluster conflict: ${conflictIds.join(", ")}`,
          canonicalEventId: null,
        })
        .where(eq(matcherDecisions.id, input.decision.id));
      return "";
    }

    const canonicalId =
      aMember?.canonicalEventId ?? bMember?.canonicalEventId ?? randomUUID();

    if (!aMember && !bMember) {
      await tx.insert(canonicalEvents).values({
        id: canonicalId,
        sport: a.sport,
        homeTeamCanonical: canonicalHome(input.candidate),
        awayTeamCanonical: canonicalAway(input.candidate),
        competitionCanonical: canonicalCompetition(input.candidate),
        kickoff: a.parsedKickoff.toISOString(),
        status: "active",
        createdByRunId: input.candidate.runId,
      });
    }

    const rowsToInsert = [
      !aMember
        ? {
            id: randomUUID(),
            canonicalEventId: canonicalId,
            snapshotId: a.id,
            provider: a.provider,
            providerEventId: a.providerEventId,
            decisionId: input.decision.id,
          }
        : null,
      !bMember
        ? {
            id: randomUUID(),
            canonicalEventId: canonicalId,
            snapshotId: b.id,
            provider: b.provider,
            providerEventId: b.providerEventId,
            decisionId: input.decision.id,
          }
        : null,
    ].filter((row): row is NonNullable<typeof row> => row !== null);

    if (rowsToInsert.length > 0) {
      await tx.insert(canonicalEventMembers).values(rowsToInsert);
    }

    await tx
      .update(canonicalEvents)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(canonicalEvents.id, canonicalId));
    await tx
      .update(matcherDecisions)
      .set({ canonicalEventId: canonicalId })
      .where(eq(matcherDecisions.id, input.decision.id));
    return canonicalId;
  });
}

export async function applyCompatibleCanonicalClusterMerge(input: {
  decision: MatcherDecisionRow;
  plan: CompatibleCanonicalClusterMergePlan;
}): Promise<string | null> {
  if (input.plan.action !== "merge" || !input.plan.canonicalEventId) {
    return null;
  }

  const targetCanonicalEventId = input.plan.canonicalEventId;
  const sourceCanonicalEventIds = input.plan.sourceCanonicalEventIds;

  await db.transaction(async (tx) => {
    if (sourceCanonicalEventIds.length > 0) {
      await tx
        .update(canonicalEventMembers)
        .set({ canonicalEventId: targetCanonicalEventId })
        .where(
          inArray(
            canonicalEventMembers.canonicalEventId,
            sourceCanonicalEventIds,
          ),
        );
      await tx
        .update(matcherDecisions)
        .set({ canonicalEventId: targetCanonicalEventId })
        .where(
          inArray(matcherDecisions.canonicalEventId, sourceCanonicalEventIds),
        );
      await tx
        .delete(canonicalEvents)
        .where(inArray(canonicalEvents.id, sourceCanonicalEventIds));
    }

    await tx
      .update(canonicalEvents)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(canonicalEvents.id, targetCanonicalEventId));
    await tx
      .update(matcherDecisions)
      .set({ canonicalEventId: targetCanonicalEventId })
      .where(eq(matcherDecisions.id, input.decision.id));
  });

  return targetCanonicalEventId;
}

export async function rebuildImpactForRun(runId: string): Promise<void> {
  const decisions = await db
    .select({
      id: matcherDecisions.id,
      decision: matcherDecisions.decision,
      decisionStage: matcherDecisions.decisionStage,
      confidenceBand: matcherDecisions.confidenceBand,
      dryRun: matcherDecisions.dryRun,
      createdAt: matcherDecisions.createdAt,
      providerA: matcherCandidates.providerA,
      providerB: matcherCandidates.providerB,
      scoreBreakdown: matcherDecisions.scoreBreakdown,
      reasonSummary: matcherDecisions.reasonSummary,
    })
    .from(matcherDecisions)
    .innerJoin(
      matcherCandidates,
      eq(matcherCandidates.id, matcherDecisions.candidateId),
    )
    .where(eq(matcherDecisions.runId, runId));

  for (const d of decisions) {
    const day = d.createdAt.slice(0, 10);
    const providerPair = [d.providerA, d.providerB].sort().join("__");
    const id = `${day}|${providerPair}|${d.decisionStage}|${d.confidenceBand}`;
    const helped = d.decision === "auto_merge" ? 1 : 0;
    const exact = d.decisionStage === "deterministic" && helped ? 1 : 0;
    const deepseek = d.decisionStage === "deepseek" ? 1 : 0;
    const reviewAvoided =
      d.decision === "auto_merge" || d.decision === "auto_reject" ? 1 : 0;
    const dryRun = d.dryRun && helped ? 1 : 0;
    await db
      .insert(matcherImpactDaily)
      .values({
        id,
        day,
        providerPair,
        sourceStage: d.decisionStage,
        confidenceBand: d.confidenceBand,
        activeMatchedEvents: helped,
        exactDeterministicMatches: exact,
        matcherHelpedMatches: helped && !exact ? 1 : 0,
        deepseekResolved: deepseek,
        reviewAvoided,
        dryRunMatches: dryRun,
        examples: [
          {
            decisionId: d.id,
            decision: d.decision,
            reason: d.reasonSummary,
          },
        ],
      })
      .onConflictDoUpdate({
        target: [
          matcherImpactDaily.day,
          matcherImpactDaily.providerPair,
          matcherImpactDaily.sourceStage,
          matcherImpactDaily.confidenceBand,
        ],
        set: {
          activeMatchedEvents: sql`${matcherImpactDaily.activeMatchedEvents} + ${helped}`,
          exactDeterministicMatches: sql`${matcherImpactDaily.exactDeterministicMatches} + ${exact}`,
          matcherHelpedMatches: sql`${matcherImpactDaily.matcherHelpedMatches} + ${helped && !exact ? 1 : 0}`,
          deepseekResolved: sql`${matcherImpactDaily.deepseekResolved} + ${deepseek}`,
          reviewAvoided: sql`${matcherImpactDaily.reviewAvoided} + ${reviewAvoided}`,
          dryRunMatches: sql`${matcherImpactDaily.dryRunMatches} + ${dryRun}`,
          updatedAt: new Date().toISOString(),
        },
      });
  }
}

export async function readImpact(limit = 50) {
  return db
    .select()
    .from(matcherImpactDaily)
    .orderBy(desc(matcherImpactDaily.day))
    .limit(limit);
}

export async function readCanonicalClusters(
  limit = 100,
): Promise<EventMatcherClusterSummary[]> {
  const latestDecision = alias(matcherDecisions, "latest_decision");
  const rows = await db
    .select({
      canonicalEventId: canonicalEvents.id,
      homeTeam: canonicalEvents.homeTeamCanonical,
      awayTeam: canonicalEvents.awayTeamCanonical,
      competition: canonicalEvents.competitionCanonical,
      kickoff: canonicalEvents.kickoff,
      memberCount: sql<number>`count(distinct ${canonicalEventMembers.id})::int`,
      providers: sql<
        string[]
      >`coalesce(array_agg(distinct ${canonicalEventMembers.provider}) filter (where ${canonicalEventMembers.provider} is not null), '{}')`,
      competitionVariants: sql<
        string[]
      >`coalesce(array_agg(distinct ${providerEventSnapshots.competitionRaw}) filter (where ${providerEventSnapshots.competitionRaw} is not null), '{}')`,
      latestDecisionAt: sql<string | null>`max(${latestDecision.createdAt})`,
      latestDecision: sql<EventMatcherDecision | null>`(array_agg(${latestDecision.decision} order by ${latestDecision.createdAt} desc))[1]`,
      latestDecisionStage: sql<EventMatcherStage | null>`(array_agg(${latestDecision.decisionStage} order by ${latestDecision.createdAt} desc))[1]`,
      latestConfidence: sql<
        number | null
      >`(array_agg(${latestDecision.confidence} order by ${latestDecision.createdAt} desc))[1]`,
      latestReasonCode: sql<
        string | null
      >`(array_agg(${latestDecision.reasonCode} order by ${latestDecision.createdAt} desc))[1]`,
    })
    .from(canonicalEvents)
    .innerJoin(
      canonicalEventMembers,
      eq(canonicalEventMembers.canonicalEventId, canonicalEvents.id),
    )
    .innerJoin(
      providerEventSnapshots,
      eq(providerEventSnapshots.id, canonicalEventMembers.snapshotId),
    )
    .leftJoin(
      latestDecision,
      eq(latestDecision.canonicalEventId, canonicalEvents.id),
    )
    .where(
      and(
        eq(canonicalEvents.status, "active"),
        nonSabaSyntheticSnapshotPredicate(providerEventSnapshots),
      ),
    )
    .groupBy(canonicalEvents.id)
    .orderBy(desc(canonicalEvents.kickoff))
    .limit(limit);

  return rows.map((row) => ({
    canonicalEventId: row.canonicalEventId,
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    competition: row.competition,
    kickoff: row.kickoff,
    memberCount: row.memberCount,
    providers: row.providers ?? [],
    competitionVariants: row.competitionVariants ?? [],
    latestDecisionAt: row.latestDecisionAt,
    latestSupport:
      row.latestDecision &&
      row.latestDecisionStage &&
      row.latestConfidence !== null &&
      row.latestReasonCode
        ? {
            decision: row.latestDecision,
            decisionStage: row.latestDecisionStage,
            confidence: row.latestConfidence,
            reasonCode: row.latestReasonCode,
          }
        : null,
  }));
}
