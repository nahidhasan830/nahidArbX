/**
 * ML Matcher Scheduler — background batch processor.
 *
 * Runs every 60 seconds (independent of the fixture/odds sync cycle).
 * Picks up all match_pairs in the `inbox` stage, batch-scores them via
 * the bi-encoder (+ optional cross-encoder escalation), and routes each
 * pair to auto-merge, auto-reject, or human_review.
 *
 * Auto-merges learn aliases through harvestMatchPair(), closing the
 * flywheel: ML merge → alias learned → string score improves →
 * fewer pairs reach inbox → ML workload decreases.
 */

import { singleton } from "../util/singleton";
import { logger } from "../shared/logger";
import {
  batchTransitionToMlQueued,
  batchTransitionToMlQueuedByIds,
  getByIds,
  updateMlScores,
  updateXeScores,
  markDecided,
  transitionStage,
} from "../db/repositories/match-pairs";
import { scorePairsBatch } from "./ml-pair-scorer";
import { harvestMatchPair } from "./entities/match-harvester";
import type { NormalizedEvent } from "../types";
import type { PreNormalizedNames } from "./normalize";

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

    const ids = selectedIds
      ? await batchTransitionToMlQueuedByIds(selectedIds)
      : await batchTransitionToMlQueued();

    if (ids.length === 0) {
      return empty;
    }

    const pairs = await getByIds(ids);
    if (pairs.length === 0) {
      return empty;
    }

    onProgress({ type: "batch_start", total: pairs.length });
    onProgress({ type: "embedding", total: pairs.length });

    const batchResult = await scorePairsBatch(pairs, {
      escalateToCrossEncoder: true,
    });

    if (!batchResult) {
      logger.warn(tag, "Matcher service unreachable, returning pairs to inbox");
      for (const id of ids) {
        await transitionStage(id, "ml_queued", "inbox");
      }
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
          await transitionStage(result.pairId, "ml_queued", "human_review");
          escalated++;
          verdict = "escalated";
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

    state.lastRunAt = new Date();
    state.lastBatchSize = pairs.length;
    state.totalProcessed += pairs.length;

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    logger.info(
      tag,
      `Batch complete in ${elapsed}s: ${merged} merged, ${rejected} rejected, ${escalated} → human_review`,
    );

    const finalResult: MlBatchResult = {
      status: "success",
      processed: pairs.length,
      merged,
      rejected,
      escalated,
    };
    recordHistory(finalResult);

    onProgress({
      type: "batch_complete",
      processed: pairs.length,
      merged,
      rejected,
      escalated,
      durationMs: Date.now() - t0,
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
    // Atomically move all inbox → ml_queued
    const ids = await batchTransitionToMlQueued();
    if (ids.length === 0) {
      return empty;
    }

    logger.info(tag, `Processing ${ids.length} pairs from inbox`);

    // Fetch full rows
    const pairs = await getByIds(ids);
    if (pairs.length === 0) {
      return empty;
    }

    // Score the batch
    const batchResult = await scorePairsBatch(pairs, {
      escalateToCrossEncoder: true,
    });

    if (!batchResult) {
      // Matcher service unreachable — move pairs back to inbox for retry
      logger.warn(tag, "Matcher service unreachable, returning pairs to inbox");
      for (const id of ids) {
        await transitionStage(id, "ml_queued", "inbox");
      }
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
          await transitionStage(result.pairId, "ml_queued", "human_review");
          escalated++;
          break;
        }
      }
    }

    state.lastRunAt = new Date();
    state.lastBatchSize = pairs.length;
    state.totalProcessed += pairs.length;

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    logger.info(
      tag,
      `Batch complete in ${elapsed}s: ${merged} merged, ${rejected} rejected, ${escalated} → human_review`,
    );

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
      home: pair.eventAHomeTeam.toLowerCase().trim(),
      away: pair.eventAAwayTeam.toLowerCase().trim(),
      competition: pair.eventACompetition.toLowerCase().trim(),
    };

    const preNormB: PreNormalizedNames = {
      home: pair.eventBHomeTeam.toLowerCase().trim(),
      away: pair.eventBAwayTeam.toLowerCase().trim(),
      competition: pair.eventBCompetition.toLowerCase().trim(),
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
