/**
 * ML Matcher Scheduler — background batch processor.
 *
 * Runs every 60 seconds (independent of the fixture/odds sync cycle).
 * Picks up all match_pairs in the `inbox` stage, batch-scores them via
 * the bi-encoder (+ optional cross-encoder escalation), then escalates
 * uncertain pairs to AI Search (Tier 2.5: Groq + web grounding)
 * before routing to human_review.
 *
 * Auto-merges learn aliases through harvestMatchPair(), closing the
 * flywheel: ML merge → alias learned → string score improves →
 * fewer pairs reach inbox → ML workload decreases.
 */

import { singleton } from "../util/singleton";
import { logger } from "../shared/logger";
import {
  listByStage,
  getByIds,
  updateMlScores,
  updateXeScores,
  markDecided,
  transitionStage,
} from "../db/repositories/match-pairs";
import { scorePairsBatch } from "./ml-pair-scorer";
import { harvestMatchPair } from "./entities/match-harvester";
import {
  normalize,
  normalizeCompetition,
} from "./entities/normalize";
import type { NormalizedEvent } from "../types";
import type { PreNormalizedNames } from "./normalize";
import { matchBatch, type AiSearchEventInfo } from "./ai-search-client";
import { getMatchingConfig } from "./config";
import { recordAiActivity } from "../db/repositories/ai-activity-log";

const tag = "MlScheduler";
const DEFAULT_INTERVAL_MS = 60_000;
const MAX_HISTORY = 50;

export interface MlRunHistoryEntry {
  runAt: string;
  durationMs: number;
  processed: number;
  merged: number;
  rejected: number;
  escalated: number;
  status: MlBatchStatus;
  trigger: "scheduler" | "manual";
}

const state = singleton("ml-scheduler", () => ({
  active: false,
  timer: null as ReturnType<typeof setTimeout> | null,
  running: false,
  intervalMs: DEFAULT_INTERVAL_MS,
  lastRunAt: null as Date | null,
  lastBatchSize: 0,
  totalProcessed: 0,
  history: [] as MlRunHistoryEntry[],
}));

export function startMlScheduler(): void {
  if (state.active) return;
  state.active = true;
  logger.info(
    tag,
    `ML matcher scheduler started (${state.intervalMs / 1000}s interval)`,
  );
  scheduleNextTick();
}

export function stopMlScheduler(): void {
  state.active = false;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  logger.info(tag, "ML matcher scheduler stopped");
}

export function setMlSchedulerEnabled(enabled: boolean): void {
  if (enabled) {
    startMlScheduler();
  } else {
    stopMlScheduler();
  }
}

export function setMlSchedulerInterval(ms: number): void {
  const clamped = Math.max(10_000, Math.min(600_000, ms));
  state.intervalMs = clamped;
  if (state.active) {
    if (state.timer) clearTimeout(state.timer);
    scheduleNextTick();
  }
  logger.info(tag, `Interval changed to ${clamped / 1000}s`);
}

export function isMlSchedulerRunning(): boolean {
  return state.active;
}

export function getMlSchedulerStats() {
  return {
    active: state.active,
    processing: state.running,
    intervalMs: state.intervalMs,
    lastRunAt: state.lastRunAt,
    lastBatchSize: state.lastBatchSize,
    totalProcessed: state.totalProcessed,
  };
}

export function getMlSchedulerHistory(): MlRunHistoryEntry[] {
  return [...state.history];
}

export type MlBatchStatus =
  | "success"
  | "empty"
  | "service_unreachable"
  | "already_running";

export interface MlBatchResult {
  status: MlBatchStatus;
  processed: number;
  merged: number;
  rejected: number;
  escalated: number;
}

/**
 * Run a single ML batch tick. Exposed for the "Run ML Now" API endpoint.
 */
export async function runMlBatchNow(): Promise<MlBatchResult> {
  return processBatch("manual");
}

export type MlProgressEventType =
  | "batch_start"
  | "transitioning"
  | "embedding"
  | "embedding_done"
  | "pair_scoring"
  | "pair_decided"
  | "service_unreachable"
  | "batch_complete";

export interface MlProgressEvent {
  type: MlProgressEventType;
  pairId?: string;
  index?: number;
  total?: number;
  verdict?: string;
  score?: number;
  merged?: number;
  rejected?: number;
  escalated?: number;
  processed?: number;
  durationMs?: number;
}

export type MlProgressCallback = (event: MlProgressEvent) => void;

/**
 * Run ML batch with per-pair progress events, for SSE streaming.
 * Accepts optional pair IDs to process only selected inbox pairs.
 */
export async function runMlBatchWithProgress(
  pairIds: string[] | null,
  onProgress: MlProgressCallback,
): Promise<MlBatchResult> {
  return processBatchWithProgress("manual", pairIds, onProgress);
}

async function processBatchWithProgress(
  trigger: "scheduler" | "manual",
  selectedIds: string[] | null,
  onProgress: MlProgressCallback,
): Promise<MlBatchResult> {
  const empty: MlBatchResult = {
    status: "empty",
    processed: 0,
    merged: 0,
    rejected: 0,
    escalated: 0,
  };

  if (state.running) {
    return { ...empty, status: "already_running" };
  }

  state.running = true;
  const t0 = Date.now();

  function recordHistory(result: MlBatchResult): void {
    if (result.processed === 0) return;
    state.history.unshift({
      runAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      processed: result.processed,
      merged: result.merged,
      rejected: result.rejected,
      escalated: result.escalated,
      status: result.status,
      trigger,
    });
    if (state.history.length > MAX_HISTORY) {
      state.history.length = MAX_HISTORY;
    }
  }

  try {
    onProgress({ type: "transitioning" });

    const pairs = selectedIds
      ? (await getByIds(selectedIds)).filter((p) => p.stage === "inbox")
      : await listByStage("inbox", { limit: 2000 });

    if (pairs.length === 0) {
      return empty;
    }

    onProgress({ type: "batch_start", total: pairs.length });
    onProgress({ type: "embedding", total: pairs.length });

    const batchResult = await scorePairsBatch(pairs, {
      escalateToCrossEncoder: true,
    });

    if (!batchResult) {
      logger.warn(tag, "Matcher service unreachable, aborting batch");
      onProgress({ type: "service_unreachable" });
      return { ...empty, status: "service_unreachable" };
    }

    onProgress({ type: "embedding_done", total: pairs.length });

    let merged = 0;
    let rejected = 0;
    let escalated = 0;

    for (let i = 0; i < batchResult.results.length; i++) {
      const result = batchResult.results[i];

      onProgress({
        type: "pair_scoring",
        pairId: result.pairId,
        index: i,
        total: batchResult.results.length,
        score: result.combinedScore,
      });

      await updateMlScores(result.pairId, {
        mlHomeCosine: result.homeCosine,
        mlAwayCosine: result.awayCosine,
        mlCompCosine: result.compCosine,
        mlCombinedScore: result.combinedScore,
        mlModelVersion: result.modelVersion,
      });

      if (result.xeScore !== undefined) {
        await updateXeScores(result.pairId, {
          xeScore: result.xeScore,
          xePvalue: result.xePvalue ?? null,
        });
      }

      let verdict: string;
      switch (result.verdict) {
        case "auto-merge": {
          const decidedBy =
            result.xeScore !== undefined ? "ml-cross-encoder" : "ml-bi-encoder";
          await markDecided(
            result.pairId,
            "auto-merge",
            decidedBy as "ml-bi-encoder" | "ml-cross-encoder",
            `combined=${result.combinedScore.toFixed(3)}` +
              (result.xeScore !== undefined
                ? ` xe=${result.xeScore.toFixed(3)}`
                : ""),
          );
          const pair = pairs.find((p) => p.id === result.pairId);
          if (pair) await learnAliasesFromPair(pair);
          merged++;
          verdict = "merged";
          break;
        }
        case "auto-reject": {
          const decidedBy =
            result.xeScore !== undefined ? "ml-cross-encoder" : "ml-bi-encoder";
          await markDecided(
            result.pairId,
            "auto-reject",
            decidedBy as "ml-bi-encoder" | "ml-cross-encoder",
            `combined=${result.combinedScore.toFixed(3)}` +
              (result.xeScore !== undefined
                ? ` xe=${result.xeScore.toFixed(3)}`
                : ""),
          );
          rejected++;
          verdict = "rejected";
          break;
        }
        case "uncertain": {
          // Collected below for AI Search batch escalation
          verdict = "uncertain-pending";
          break;
        }
        default:
          verdict = "unknown";
      }

      onProgress({
        type: "pair_decided",
        pairId: result.pairId,
        index: i,
        total: batchResult.results.length,
        verdict,
        score: result.combinedScore,
        merged,
        rejected,
        escalated,
      });
    }

    // ── Tier 2.5: AI Search escalation for uncertain pairs ──
    const uncertainResultsP = batchResult.results.filter(
      (r) => r.verdict === "uncertain",
    );
    if (uncertainResultsP.length > 0) {
      onProgress({
        type: "pair_scoring",
        pairId: `ai-search-batch`,
        index: batchResult.results.length,
        total: batchResult.results.length + 1,
        score: 0,
      });
    }
    const aiSearchResultP = await escalateToAiSearch(
      uncertainResultsP.map((r) => r.pairId),
      pairs,
    );
    merged += aiSearchResultP.merged;
    rejected += aiSearchResultP.rejected;
    escalated += aiSearchResultP.escalated;

    if (aiSearchResultP.attempted > 0) {
      onProgress({
        type: "pair_decided",
        pairId: `ai-search-batch`,
        index: batchResult.results.length,
        total: batchResult.results.length + 1,
        verdict: `ai-search: ${aiSearchResultP.merged}m/${aiSearchResultP.rejected}r/${aiSearchResultP.escalated}h`,
        score: 0,
        merged,
        rejected,
        escalated,
      });
    }

    state.lastRunAt = new Date();
    state.lastBatchSize = pairs.length;
    state.totalProcessed += pairs.length;

    const durationMs = Date.now() - t0;
    const elapsed = (durationMs / 1000).toFixed(1);
    const aiMsgP = aiSearchResultP.attempted > 0
      ? `, AI Search: ${aiSearchResultP.merged}m/${aiSearchResultP.rejected}r/${aiSearchResultP.escalated}h of ${aiSearchResultP.attempted}`
      : "";
    logger.info(
      tag,
      `Batch complete in ${elapsed}s: ${merged} merged, ${rejected} rejected, ${escalated} → human_review${aiMsgP}`,
    );

    const finalResult: MlBatchResult = {
      status: "success",
      processed: pairs.length,
      merged,
      rejected,
      escalated,
    };
    recordHistory(finalResult);

    // ── AI Activity log for ML batch ──
    recordAiActivity({
      system: "entity-match",
      trigger: trigger === "manual" ? "manual" : "auto-scheduler",
      status: "success",
      model: batchResult.results[0]?.modelVersion ?? "bi-encoder",
      itemCount: pairs.length,
      durationMs,
      costUsd: null,
      summary: `ML batch: ${merged} merged, ${rejected} rejected, ${escalated} → review${aiMsgP}`,
      error: null,
      metadata: {
        merged,
        rejected,
        escalated,
        aiSearchAttempted: aiSearchResultP.attempted,
        aiSearchMerged: aiSearchResultP.merged,
        aiSearchRejected: aiSearchResultP.rejected,
      },
    }).catch(() => {});

    onProgress({
      type: "batch_complete",
      processed: pairs.length,
      merged,
      rejected,
      escalated,
      durationMs,
    });

    return finalResult;
  } catch (err) {
    logger.error(
      tag,
      `processBatchWithProgress failed: ${(err as Error).message}`,
    );
    const result: MlBatchResult = {
      status: "service_unreachable",
      processed: 0,
      merged: 0,
      rejected: 0,
      escalated: 0,
    };
    recordHistory(result);
    return result;
  } finally {
    state.running = false;
  }
}

function scheduleNextTick(): void {
  if (!state.active) return;
  state.timer = setTimeout(async () => {
    if (!state.active) return;
    await processBatch("scheduler");
    scheduleNextTick();
  }, state.intervalMs);
}

async function processBatch(
  trigger: "scheduler" | "manual" = "scheduler",
): Promise<MlBatchResult> {
  const empty: MlBatchResult = {
    status: "empty",
    processed: 0,
    merged: 0,
    rejected: 0,
    escalated: 0,
  };

  if (state.running) {
    return { ...empty, status: "already_running" };
  }

  state.running = true;
  const t0 = Date.now();

  function recordHistory(result: MlBatchResult): void {
    if (result.processed === 0) return;
    state.history.unshift({
      runAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      processed: result.processed,
      merged: result.merged,
      rejected: result.rejected,
      escalated: result.escalated,
      status: result.status,
      trigger,
    });
    if (state.history.length > MAX_HISTORY) {
      state.history.length = MAX_HISTORY;
    }
  }

  try {
    // Fetch pairs directly from inbox
    const pairs = await listByStage("inbox", { limit: 2000 });
    if (pairs.length === 0) {
      return empty;
    }

    logger.info(tag, `Processing ${pairs.length} pairs from inbox`);

    // Score the batch
    const batchResult = await scorePairsBatch(pairs, {
      escalateToCrossEncoder: true,
    });

    if (!batchResult) {
      // Matcher service unreachable — abort
      logger.warn(tag, "Matcher service unreachable, aborting batch");
      const r = { ...empty, status: "service_unreachable" as const };
      return r;
    }

    let merged = 0;
    let rejected = 0;
    let escalated = 0;

    for (const result of batchResult.results) {
      // Write ML scores to the row
      await updateMlScores(result.pairId, {
        mlHomeCosine: result.homeCosine,
        mlAwayCosine: result.awayCosine,
        mlCompCosine: result.compCosine,
        mlCombinedScore: result.combinedScore,
        mlModelVersion: result.modelVersion,
      });

      if (result.xeScore !== undefined) {
        await updateXeScores(result.pairId, {
          xeScore: result.xeScore,
          xePvalue: result.xePvalue ?? null,
        });
      }

      // Route based on verdict
      switch (result.verdict) {
        case "auto-merge": {
          const decidedBy =
            result.xeScore !== undefined ? "ml-cross-encoder" : "ml-bi-encoder";
          await markDecided(
            result.pairId,
            "auto-merge",
            decidedBy as "ml-bi-encoder" | "ml-cross-encoder",
            `combined=${result.combinedScore.toFixed(3)}` +
              (result.xeScore !== undefined
                ? ` xe=${result.xeScore.toFixed(3)}`
                : ""),
          );

          // Learn aliases from the merge
          const pair = pairs.find((p) => p.id === result.pairId);
          if (pair) {
            await learnAliasesFromPair(pair);
          }

          merged++;
          break;
        }

        case "auto-reject": {
          const decidedBy =
            result.xeScore !== undefined ? "ml-cross-encoder" : "ml-bi-encoder";
          await markDecided(
            result.pairId,
            "auto-reject",
            decidedBy as "ml-bi-encoder" | "ml-cross-encoder",
            `combined=${result.combinedScore.toFixed(3)}` +
              (result.xeScore !== undefined
                ? ` xe=${result.xeScore.toFixed(3)}`
                : ""),
          );
          rejected++;
          break;
        }

        case "uncertain": {
          // Collected below for AI Search batch escalation
          break;
        }
      }
    }

    // ── Tier 2.5: AI Search escalation for uncertain pairs ──
    const uncertainResults = batchResult.results.filter(
      (r) => r.verdict === "uncertain",
    );
    const aiSearchResult = await escalateToAiSearch(
      uncertainResults.map((r) => r.pairId),
      pairs,
    );
    merged += aiSearchResult.merged;
    rejected += aiSearchResult.rejected;
    escalated += aiSearchResult.escalated;

    state.lastRunAt = new Date();
    state.lastBatchSize = pairs.length;
    state.totalProcessed += pairs.length;

    const durationMs = Date.now() - t0;
    const elapsed = (durationMs / 1000).toFixed(1);
    const aiMsg = aiSearchResult.attempted > 0
      ? `, AI Search: ${aiSearchResult.merged}m/${aiSearchResult.rejected}r/${aiSearchResult.escalated}h of ${aiSearchResult.attempted}`
      : "";
    logger.info(
      tag,
      `Batch complete in ${elapsed}s: ${merged} merged, ${rejected} rejected, ${escalated} → human_review${aiMsg}`,
    );

    // ── AI Activity log for scheduled ML batch ──
    recordAiActivity({
      system: "entity-match",
      trigger: trigger === "manual" ? "manual" : "auto-scheduler",
      status: "success",
      model: batchResult.results[0]?.modelVersion ?? "bi-encoder",
      itemCount: pairs.length,
      durationMs,
      costUsd: null,
      summary: `ML batch: ${merged} merged, ${rejected} rejected, ${escalated} → review${aiMsg}`,
      error: null,
      metadata: {
        merged,
        rejected,
        escalated,
        aiSearchAttempted: aiSearchResult.attempted,
        aiSearchMerged: aiSearchResult.merged,
        aiSearchRejected: aiSearchResult.rejected,
      },
    }).catch(() => {});

    const result: MlBatchResult = {
      status: "success",
      processed: pairs.length,
      merged,
      rejected,
      escalated,
    };
    recordHistory(result);
    return result;
  } catch (err) {
    logger.error(tag, `processBatch failed: ${(err as Error).message}`);
    const result: MlBatchResult = {
      status: "service_unreachable",
      processed: 0,
      merged: 0,
      rejected: 0,
      escalated: 0,
    };
    recordHistory(result);
    return result;
  } finally {
    state.running = false;
  }
}

/**
 * Escalate uncertain pairs to the local AI Search service (Tier 2.5).
 *
 * Batches pairs to the `/entity-match-batch` endpoint (Groq + web
 * search grounding). Routes based on verdict + confidence threshold:
 *   - SAME at ≥ threshold  → auto-merge + learn aliases
 *   - DIFFERENT at ≥ threshold → auto-reject
 *   - Otherwise            → human_review
 *
 * Returns counts for the caller to aggregate. If AI Search is disabled
 * or unreachable, all pairs go to human_review.
 */
async function escalateToAiSearch(
  pairIds: string[],
  allPairs: Awaited<ReturnType<typeof getByIds>>,
): Promise<{
  attempted: number;
  merged: number;
  rejected: number;
  escalated: number;
}> {
  const result = { attempted: 0, merged: 0, rejected: 0, escalated: 0 };

  if (pairIds.length === 0) return result;

  const config = getMatchingConfig();
  if (!config.aiSearchEscalation.enabled) {
    // AI Search disabled — send all to human_review
    for (const id of pairIds) {
      await transitionStage(id, "inbox", "human_review");
      result.escalated++;
    }
    return result;
  }

  result.attempted = pairIds.length;
  const threshold = config.aiSearchEscalation.confidenceThreshold;

  // Build AI Search request payloads
  const pairMap = new Map(allPairs.map((p) => [p.id, p]));
  const aiPairs: Array<{
    id: string;
    event_a: AiSearchEventInfo;
    event_b: AiSearchEventInfo;
  }> = [];

  for (const id of pairIds) {
    const pair = pairMap.get(id);
    if (!pair) {
      await transitionStage(id, "inbox", "human_review");
      result.escalated++;
      continue;
    }

    aiPairs.push({
      id,
      event_a: {
        home_team: pair.eventAHomeTeam,
        away_team: pair.eventAAwayTeam,
        competition: pair.eventACompetition,
        start_time: pair.eventAStartTime,
        provider: pair.eventAProvider,
      },
      event_b: {
        home_team: pair.eventBHomeTeam,
        away_team: pair.eventBAwayTeam,
        competition: pair.eventBCompetition,
        start_time: pair.eventBStartTime,
        provider: pair.eventBProvider,
      },
    });
  }

  if (aiPairs.length === 0) return result;

  logger.info(
    tag,
    `Escalating ${aiPairs.length} uncertain pairs to AI Search`,
  );

  // Call AI Search batch
  const batchResult = await matchBatch(
    aiPairs.map((p) => ({ event_a: p.event_a, event_b: p.event_b })),
  );

  if (!batchResult) {
    // AI Search unreachable — send all to human_review
    logger.warn(tag, "AI Search unreachable, routing uncertain pairs to human_review");
    for (const p of aiPairs) {
      await transitionStage(p.id, "inbox", "human_review");
      result.escalated++;
    }
    return result;
  }

  // Route each pair based on AI Search verdict
  for (const verdict of batchResult.verdicts) {
    const pair = aiPairs[verdict.pair_index];
    if (!pair) continue;

    const decision = verdict.decision;
    const confidence = verdict.confidence;

    if (decision === "SAME" && confidence >= threshold) {
      await markDecided(
        pair.id,
        "ai-merge",
        "ai-search",
        `ai-search: ${decision} ${confidence}% — ${verdict.reasoning.slice(0, 200)}`,
      );
      const dbPair = pairMap.get(pair.id);
      if (dbPair) await learnAliasesFromPair(dbPair);
      result.merged++;
    } else if (decision === "DIFFERENT" && confidence >= threshold) {
      await markDecided(
        pair.id,
        "ai-reject",
        "ai-search",
        `ai-search: ${decision} ${confidence}% — ${verdict.reasoning.slice(0, 200)}`,
      );
      result.rejected++;
    } else {
      // Low confidence or UNCERTAIN → human_review
      await transitionStage(pair.id, "inbox", "human_review");
      result.escalated++;
    }
  }

  // Handle any pairs not covered by verdicts (LLM returned fewer items)
  const verdictIndices = new Set(batchResult.verdicts.map((v) => v.pair_index));
  for (let i = 0; i < aiPairs.length; i++) {
    if (!verdictIndices.has(i)) {
      await transitionStage(aiPairs[i].id, "inbox", "human_review");
      result.escalated++;
    }
  }

  logger.info(
    tag,
    `AI Search resolved: ${result.merged} merged, ${result.rejected} rejected, ${result.escalated} → human_review (model: ${batchResult.model})`,
  );

  return result;
}

/**
 * Build synthetic NormalizedEvent + PreNormalizedNames from a match_pairs
 * row and feed them through harvestMatchPair() so the entity-resolution
 * store learns the alias mapping.
 */
async function learnAliasesFromPair(
  pair: Awaited<ReturnType<typeof getByIds>>[number],
): Promise<void> {
  try {
    const eventA: NormalizedEvent = {
      id: pair.eventAEventId ?? `ml-${pair.id}-a`,
      sport: "football",
      homeTeam: pair.eventAHomeTeam,
      awayTeam: pair.eventAAwayTeam,
      competition: pair.eventACompetition,
      startTime: new Date(pair.eventAStartTime),
      providers: {
        [pair.eventAProvider]: { eventId: pair.eventAEventId ?? "" },
      } as NormalizedEvent["providers"],
    };

    const eventB: NormalizedEvent = {
      id: pair.eventBEventId ?? `ml-${pair.id}-b`,
      sport: "football",
      homeTeam: pair.eventBHomeTeam,
      awayTeam: pair.eventBAwayTeam,
      competition: pair.eventBCompetition,
      startTime: new Date(pair.eventBStartTime),
      providers: {
        [pair.eventBProvider]: { eventId: pair.eventBEventId ?? "" },
      } as NormalizedEvent["providers"],
    };

    const preNormA: PreNormalizedNames = {
      home: normalize(pair.eventAHomeTeam),
      away: normalize(pair.eventAAwayTeam),
      competition: normalizeCompetition(pair.eventACompetition),
    };

    const preNormB: PreNormalizedNames = {
      home: normalize(pair.eventBHomeTeam),
      away: normalize(pair.eventBAwayTeam),
      competition: normalizeCompetition(pair.eventBCompetition),
    };

    await harvestMatchPair(
      eventA,
      eventB,
      preNormA,
      preNormB,
      pair.mlCombinedScore ?? pair.stringScore,
    );
  } catch (err) {
    logger.warn(
      tag,
      `learnAliasesFromPair failed for ${pair.id}: ${(err as Error).message}`,
    );
  }
}
