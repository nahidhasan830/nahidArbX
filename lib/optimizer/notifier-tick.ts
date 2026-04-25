/**
 * Optimisation — Telegram notification for completed optimizer runs.
 *
 * Runs on the same interval as `scheduler.ts` (one tick function call per
 * 30s poll). Claims every row in `optimization_runs` that:
 *
 *   - has hit a terminal status (`completed | failed | cancelled`),
 *   - has `notify_on_complete = true`, and
 *   - has `notified_at IS NULL` (never been pinged).
 *
 * For each claimed row we emit an `optimizer:run_completed` event through
 * the shared notifier fan-out (so any channel — Telegram today, possibly
 * Slack/email tomorrow — picks it up) and stamp `notified_at` with the
 * current time. `notified_at` is the idempotency key: if the tick dies or
 * the Telegram API is rate-limited we'll never double-ping the same run.
 *
 * Design choices:
 *   - **At-most-once** semantics. Better to miss a ping (which is cosmetic)
 *     than to spam chat with duplicates. We stamp `notified_at` even if
 *     `notify()` throws — the fan-out itself logs the error; the run row
 *     won't be retried.
 *   - **Single-SELECT batch.** The claim query uses a partial index
 *     (`optimization_runs_notify_pending_idx`) so it's O(pending) regardless
 *     of table size. LIMIT 10 caps per-tick work at one-Telegram-rate-limit
 *     window.
 *   - **Best-trial fan-in.** For completed runs with a best-trial id, we
 *     fetch one row from `optimization_trials` so the notification includes
 *     ROI ± CI / Sharpe / Sortino / DSR / PSR without the Telegram channel
 *     needing to re-query the DB.
 */

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  optimizationRuns,
  optimizationTrials,
  type OptimizationRunRow,
  type OptimizationTrialRow,
} from "../db/schema";
import { notify } from "../notifier";
import type {
  OptimizerRunCompletedEvent,
  OptimizerRunStartedEvent,
} from "../notifier/types";
import { logger } from "../shared/logger";
import {
  formatCvStrategyLabel,
  formatScopeSummary,
  getEstimatedRunDurationSec,
  previewDataset,
} from "./repository";
import type { CvStrategyJson, DataFiltersJson, RunSummaryJson } from "./types";

const tag = "OptimizerNotifierTick";
const CLAIM_BATCH_LIMIT = 10;

function appBaseUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_APP_URL;
  if (!raw) return null;
  return raw.replace(/\/$/, "");
}

/** Normalise the nullable numeric column reads coming from drizzle. */
function nz(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function toEvent(
  run: OptimizationRunRow,
  bestTrial: OptimizationTrialRow | null,
): OptimizerRunCompletedEvent {
  const baseUrl = appBaseUrl();
  const completedAt = (run.completedAt ?? new Date().toISOString()) as string;
  const startedAt = (run.startedAt ?? null) as string | null;
  const durationSec = startedAt
    ? Math.max(
        0,
        Math.round(
          (new Date(completedAt).getTime() - new Date(startedAt).getTime()) /
            1000,
        ),
      )
    : 0;

  const summary = (run.summary ?? null) as RunSummaryJson | null;

  const best: OptimizerRunCompletedEvent["best"] =
    bestTrial && run.status === "completed"
      ? {
          trialId: bestTrial.id,
          trialIndex: bestTrial.trialIndex ?? null,
          roiPct: nz(bestTrial.oosRoiMean),
          roiCiLow: nz(bestTrial.oosRoiCiLow),
          roiCiHigh: nz(bestTrial.oosRoiCiHigh),
          sharpe: nz(bestTrial.oosSharpe),
          sortino: nz(bestTrial.oosSortino),
          maxDrawdownPct: nz(bestTrial.maxDrawdown),
          deflatedSharpe: nz(bestTrial.deflatedSharpe),
          probabilisticSharpe: nz(bestTrial.probabilisticSharpe),
          sampleSize: bestTrial.sampleSize ?? null,
        }
      : null;

  return {
    type: "optimizer:run_completed",
    at: new Date().toISOString(),
    runId: run.id,
    name: run.name,
    status: run.status as OptimizerRunCompletedEvent["status"],
    searchAlgorithm: run.searchAlgorithm,
    startedAt,
    completedAt,
    durationSec,
    nTrialsDone: run.nTrialsDone,
    nTrialsTarget: run.nTrialsTarget,
    nPareto: summary?.n_pareto ?? null,
    bestComposite: summary?.best_composite_score ?? null,
    best,
    createdBy: run.createdBy ?? "manual",
    error: run.error ?? null,
    dashboardUrl: baseUrl ? `${baseUrl}/lab/optimisation/${run.id}` : undefined,
    topTrialUrl:
      baseUrl && bestTrial
        ? `${baseUrl}/lab/optimisation/${run.id}#trial=${bestTrial.trialIndex}`
        : undefined,
  };
}

async function loadBestTrials(
  runs: OptimizationRunRow[],
): Promise<Map<string, OptimizationTrialRow>> {
  const ids = runs
    .map((r) => r.bestTrialId)
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(optimizationTrials)
    .where(inArray(optimizationTrials.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Claim every pending-notification run, stamp `notified_at`, and fire the
 * Telegram fan-out for each. Safe to call from the existing scheduler tick;
 * no external state.
 */
export async function processPendingRunNotifications(): Promise<number> {
  // 1. Claim pending rows. The UPDATE … RETURNING * runs atomically so two
  //    concurrent ticks (HMR reload edge case) never fight over the same row.
  const claimed: OptimizationRunRow[] = await db
    .update(optimizationRuns)
    .set({ notifiedAt: sql`now()` })
    .where(
      and(
        eq(optimizationRuns.notifyOnComplete, true),
        isNull(optimizationRuns.notifiedAt),
        inArray(optimizationRuns.status, ["completed", "failed", "cancelled"]),
        // Only pings runs whose completedAt is non-null (= the sidecar has
        // written the terminal status). Prevents an early race where status
        // flips before summary is populated.
        sql`${optimizationRuns.completedAt} IS NOT NULL`,
      ),
    )
    .returning();

  if (claimed.length === 0) return 0;

  // Cap per tick to avoid flooding Telegram on a bulk status flip.
  const batch = claimed.slice(0, CLAIM_BATCH_LIMIT);
  // If we claimed more than the cap, release the overflow so the next tick
  // picks them up (re-null notifiedAt for the overflow rows).
  if (claimed.length > CLAIM_BATCH_LIMIT) {
    const overflow = claimed.slice(CLAIM_BATCH_LIMIT).map((r) => r.id);
    await db
      .update(optimizationRuns)
      .set({ notifiedAt: null })
      .where(inArray(optimizationRuns.id, overflow));
  }

  const bestTrials = await loadBestTrials(batch);

  let sent = 0;
  for (const run of batch) {
    try {
      const best = run.bestTrialId
        ? (bestTrials.get(run.bestTrialId) ?? null)
        : null;
      const event = toEvent(run, best);
      await notify(event);
      sent += 1;
      logger.info(
        tag,
        `Sent notification for run ${run.id} (${run.status}, trials ${run.nTrialsDone}/${run.nTrialsTarget})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // We leave `notified_at` stamped — at-most-once; the fan-out itself
      // already logged whichever channel failed.
      logger.warn(
        tag,
        `Failed to dispatch notification for run ${run.id}: ${msg}`,
      );
    }
  }
  return sent;
}

// ─── "Run started" Telegram ping ─────────────────────────────────────────
//
// Mirrors processPendingRunNotifications but keyed off `started_at` and
// `started_notified_at`. Fires once the sidecar picks a queued run up, so
// the operator knows what's cooking plus the estimated finish time. The
// claim query also matches runs that have already moved past `running`
// (e.g. a very short run that completed between polls) — we still want
// to send the "started" ping in that case for audit completeness.

async function buildRunStartedEvent(
  run: OptimizationRunRow,
): Promise<OptimizerRunStartedEvent> {
  const baseUrl = appBaseUrl();
  const startedAt = (run.startedAt ?? new Date().toISOString()) as string;

  // Resolve bet count + scope summary from the stored data_filters. Swallow
  // any preview errors — an ETA line with no scope is still useful.
  let betCount: number | null = null;
  try {
    const preview = await previewDataset(
      (run.dataFilters ?? {}) as DataFiltersJson,
    );
    betCount = preview.included;
  } catch (err) {
    logger.warn(
      tag,
      `previewDataset failed for run ${run.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ETA — independent of preview; safe to fall through to null on error.
  let estimatedDurationSec: number | null = null;
  let estimationBasis: string | null = null;
  try {
    const est = await getEstimatedRunDurationSec({
      nTrialsTarget: run.nTrialsTarget,
      cvStrategy: ((run.cvStrategy as CvStrategyJson | null)?.type ??
        "cpcv") as string,
      searchAlgorithm: run.searchAlgorithm,
    });
    estimatedDurationSec = est.estimatedSec;
    estimationBasis = est.basis;
  } catch (err) {
    logger.warn(
      tag,
      `ETA lookup failed for run ${run.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const estimatedFinishAt =
    estimatedDurationSec != null
      ? new Date(
          new Date(startedAt).getTime() + estimatedDurationSec * 1000,
        ).toISOString()
      : null;

  return {
    type: "optimizer:run_started",
    at: new Date().toISOString(),
    runId: run.id,
    name: run.name,
    searchAlgorithm: run.searchAlgorithm,
    rngSeed: run.rngSeed,
    nTrialsTarget: run.nTrialsTarget,
    cvStrategyLabel: formatCvStrategyLabel(run.cvStrategy as CvStrategyJson),
    startedAt,
    betCount,
    scopeSummary: formatScopeSummary(run.dataFilters as DataFiltersJson),
    estimatedDurationSec,
    estimationBasis,
    estimatedFinishAt,
    createdBy: run.createdBy ?? "manual",
    dashboardUrl: baseUrl ? `${baseUrl}/lab/optimisation/${run.id}` : undefined,
  };
}

/**
 * Claim every pending "run started" notification and fire it. Called from
 * the same scheduler tick as processPendingRunNotifications.
 */
export async function processPendingRunStartedNotifications(): Promise<number> {
  const claimed: OptimizationRunRow[] = await db
    .update(optimizationRuns)
    .set({ startedNotifiedAt: sql`now()` })
    .where(
      and(
        eq(optimizationRuns.notifyOnStart, true),
        isNotNull(optimizationRuns.startedAt),
        isNull(optimizationRuns.startedNotifiedAt),
      ),
    )
    .returning();

  if (claimed.length === 0) return 0;

  // Cap per tick to respect Telegram rate limits (same pattern as the
  // completion ping). Overflow is released for the next tick.
  const batch = claimed.slice(0, CLAIM_BATCH_LIMIT);
  if (claimed.length > CLAIM_BATCH_LIMIT) {
    const overflow = claimed.slice(CLAIM_BATCH_LIMIT).map((r) => r.id);
    await db
      .update(optimizationRuns)
      .set({ startedNotifiedAt: null })
      .where(inArray(optimizationRuns.id, overflow));
  }

  let sent = 0;
  for (const run of batch) {
    try {
      const event = await buildRunStartedEvent(run);
      await notify(event);
      sent += 1;
      logger.info(
        tag,
        `Sent run-started notification for run ${run.id} (ETA ${event.estimatedDurationSec ?? "—"}s, dataset ${event.betCount ?? "—"})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        tag,
        `Failed to dispatch run-started notification for run ${run.id}: ${msg}`,
      );
    }
  }
  return sent;
}
