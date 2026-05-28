import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { matcherConfig, matcherRuns, type MatchPairRow } from "../db/schema";
import {
  getByIds,
  markDecidedFromStage,
  type MatchPairDecision,
} from "../db/repositories/match-pairs";
import {
  matchBatch,
  type AiSearchBatchResult,
  type AiSearchEventInfo,
} from "./ai-search-client";
import { learnAliasesForMatchPair } from "./matcher-lab-aliases";
import { logger } from "../shared/logger";

const tag = "MatcherLabAiResolver";

export interface MatcherSchedulerRunResult {
  status?: string;
  processed?: number;
  merged?: number;
  rejected?: number;
  escalated?: number;
  durationMs?: number;
  runId?: string;
  escalatedPairIds?: string[];
  aiSearchAttempted?: number;
  aiSearchMerged?: number;
  aiSearchRejected?: number;
}

export interface MatcherAiResolverConfig {
  enabled: boolean;
  confidenceThreshold: number;
  maxBatchSize: number;
}

export interface MatcherAiResolverSummary {
  attempted: number;
  merged: number;
  rejected: number;
  leftForHuman: number;
  failed: number;
}

interface CandidatePair {
  row: MatchPairRow;
  event_a: AiSearchEventInfo;
  event_b: AiSearchEventInfo;
}

export interface MatcherAiResolverDeps {
  loadConfig: () => Promise<MatcherAiResolverConfig>;
  loadPairs: (ids: string[]) => Promise<MatchPairRow[]>;
  matchBatch: typeof matchBatch;
  markDecision: (
    pair: MatchPairRow,
    decision: MatchPairDecision,
    reason: string,
  ) => Promise<boolean>;
  updateRunStats: (
    runId: string | undefined,
    summary: MatcherAiResolverSummary,
  ) => Promise<void>;
}

const defaultDeps: MatcherAiResolverDeps = {
  async loadConfig() {
    const rows = await db
      .select({
        enabled: matcherConfig.aiSearchEnabled,
        confidenceThreshold: matcherConfig.aiSearchConfidenceThreshold,
        maxBatchSize: matcherConfig.aiSearchMaxBatchSize,
      })
      .from(matcherConfig)
      .where(eq(matcherConfig.id, "default"))
      .limit(1);

    const row = rows[0];
    return {
      enabled: row?.enabled ?? true,
      confidenceThreshold: row?.confidenceThreshold ?? 70,
      maxBatchSize: Math.max(1, Math.min(20, row?.maxBatchSize ?? 20)),
    };
  },
  loadPairs: getByIds,
  matchBatch,
  async markDecision(pair, decision, reason) {
    const ok = await markDecidedFromStage(
      pair.id,
      "human_review",
      decision,
      "ai-search",
      reason,
    );
    if (ok && decision === "ai-merge") {
      await learnAliasesForMatchPair(pair);
    }
    return ok;
  },
  async updateRunStats(runId, summary) {
    if (!runId || summary.attempted === 0) return;
    const resolved = summary.merged + summary.rejected;
    await db
      .update(matcherRuns)
      .set({
        aiSearchAttempted: summary.attempted,
        aiSearchMerged: summary.merged,
        aiSearchRejected: summary.rejected,
        merged: sql`${matcherRuns.merged} + ${summary.merged}`,
        rejected: sql`${matcherRuns.rejected} + ${summary.rejected}`,
        escalated: sql`greatest(${matcherRuns.escalated} - ${resolved}, 0)`,
      })
      .where(
        and(
          eq(matcherRuns.id, runId),
          eq(matcherRuns.aiSearchAttempted, 0),
        ),
      );
  },
};

export async function resolveMatcherRunWithAiSearch(
  run: MatcherSchedulerRunResult,
  deps: MatcherAiResolverDeps = defaultDeps,
): Promise<MatcherSchedulerRunResult> {
  try {
    return await resolveMatcherRunWithAiSearchInner(run, deps);
  } catch (err) {
    logger.warn(
      tag,
      `AI Search resolver failed after ML run: ${(err as Error).message}`,
    );
    return withAiDefaults(run);
  }
}

async function resolveMatcherRunWithAiSearchInner(
  run: MatcherSchedulerRunResult,
  deps: MatcherAiResolverDeps,
): Promise<MatcherSchedulerRunResult> {
  if (run.status !== "success") return withAiDefaults(run);

  const pairIds = [...new Set(run.escalatedPairIds ?? [])];
  if (pairIds.length === 0) return withAiDefaults(run);

  const config = await deps.loadConfig();
  if (!config.enabled) return withAiDefaults(run);

  const rows = await deps.loadPairs(pairIds);
  const candidates = rows
    .filter((row) => row.stage === "human_review")
    .map(toCandidatePair);

  const summary: MatcherAiResolverSummary = {
    attempted: 0,
    merged: 0,
    rejected: 0,
    leftForHuman: pairIds.length - candidates.length,
    failed: 0,
  };

  for (const chunk of chunkPairs(candidates, config.maxBatchSize)) {
    summary.attempted += chunk.length;
    const batch = await deps.matchBatch(
      chunk.map((pair) => ({
        event_a: pair.event_a,
        event_b: pair.event_b,
      })),
    );

    if (!batch) {
      summary.failed += chunk.length;
      summary.leftForHuman += chunk.length;
      continue;
    }

    await applyBatchVerdicts(chunk, batch, config, deps, summary);
  }

  await deps.updateRunStats(run.runId, summary);

  if (summary.attempted > 0) {
    logger.info(
      tag,
      `AI Search resolved ${summary.merged} merge / ${summary.rejected} reject / ${summary.leftForHuman} review of ${summary.attempted} attempted`,
    );
  }

  return mergeSummaryIntoRun(run, summary);
}

function withAiDefaults(
  run: MatcherSchedulerRunResult,
): MatcherSchedulerRunResult {
  return {
    ...run,
    aiSearchAttempted: run.aiSearchAttempted ?? 0,
    aiSearchMerged: run.aiSearchMerged ?? 0,
    aiSearchRejected: run.aiSearchRejected ?? 0,
  };
}

function mergeSummaryIntoRun(
  run: MatcherSchedulerRunResult,
  summary: MatcherAiResolverSummary,
): MatcherSchedulerRunResult {
  const resolved = summary.merged + summary.rejected;
  return {
    ...run,
    merged: (run.merged ?? 0) + summary.merged,
    rejected: (run.rejected ?? 0) + summary.rejected,
    escalated: Math.max(0, (run.escalated ?? 0) - resolved),
    aiSearchAttempted: summary.attempted,
    aiSearchMerged: summary.merged,
    aiSearchRejected: summary.rejected,
  };
}

async function applyBatchVerdicts(
  chunk: CandidatePair[],
  batch: AiSearchBatchResult,
  config: MatcherAiResolverConfig,
  deps: MatcherAiResolverDeps,
  summary: MatcherAiResolverSummary,
): Promise<void> {
  const covered = new Set<number>();

  for (const verdict of batch.verdicts) {
    const pair = chunk[verdict.pair_index];
    if (!pair) continue;
    covered.add(verdict.pair_index);

    const confidence = toPercent(verdict.confidence);
    if (verdict.decision === "SAME" && confidence >= config.confidenceThreshold) {
      const ok = await markWithFallback(
        deps,
        pair.row,
        "ai-merge",
        buildReason(verdict.decision, confidence, verdict.reasoning),
        summary,
      );
      if (ok) summary.merged++;
      else summary.leftForHuman++;
    } else if (
      verdict.decision === "DIFFERENT" &&
      confidence >= config.confidenceThreshold
    ) {
      const ok = await markWithFallback(
        deps,
        pair.row,
        "ai-reject",
        buildReason(verdict.decision, confidence, verdict.reasoning),
        summary,
      );
      if (ok) summary.rejected++;
      else summary.leftForHuman++;
    } else {
      summary.leftForHuman++;
    }
  }

  for (let i = 0; i < chunk.length; i++) {
    if (!covered.has(i)) summary.leftForHuman++;
  }
}

async function markWithFallback(
  deps: MatcherAiResolverDeps,
  pair: MatchPairRow,
  decision: MatchPairDecision,
  reason: string,
  summary: MatcherAiResolverSummary,
): Promise<boolean> {
  try {
    return await deps.markDecision(pair, decision, reason);
  } catch (err) {
    summary.failed++;
    logger.warn(
      tag,
      `AI Search could not apply ${decision} for ${pair.id}: ${(err as Error).message}`,
    );
    return false;
  }
}

function toCandidatePair(row: MatchPairRow): CandidatePair {
  return {
    row,
    event_a: {
      home_team: row.eventAHomeTeam,
      away_team: row.eventAAwayTeam,
      competition: row.eventACompetition,
      start_time: row.eventAStartTime,
      provider: row.eventAProvider,
    },
    event_b: {
      home_team: row.eventBHomeTeam,
      away_team: row.eventBAwayTeam,
      competition: row.eventBCompetition,
      start_time: row.eventBStartTime,
      provider: row.eventBProvider,
    },
  };
}

function chunkPairs<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function toPercent(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  return confidence <= 1 ? confidence * 100 : confidence;
}

function buildReason(
  decision: "SAME" | "DIFFERENT" | "UNCERTAIN",
  confidence: number,
  reasoning: string,
): string {
  return [`ai-search: ${decision} ${Math.round(confidence)}%`, reasoning]
    .filter(Boolean)
    .join(" - ")
    .slice(0, 500);
}
