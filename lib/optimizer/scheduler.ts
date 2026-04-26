/**
 * Next.js-side optimizer scheduler.
 *
 * Polls `optimization_runs WHERE status='queued'` every 5s and tells the
 * Python sidecar to start each one. The sidecar owns all status transitions
 * after kickoff — this scheduler is fire-and-forget.
 *
 * Pattern mirrors `lib/settle/scheduler.ts`: singleton state, idempotent
 * (HMR-safe), errors logged + swallowed (don't poison the loop).
 */

import { logger } from "../shared/logger";
import { singleton } from "../util/singleton";
import { triggerJobExecution } from "./api-client";
import { recomputeLiveMetrics } from "./live-metrics-aggregator";
import {
  processPendingRunNotifications,
  processPendingRunStartedNotifications,
} from "./notifier-tick";
import {
  claimQueuedRun,
  createRun,
  listQueuedRuns,
  reconcileStuckClaims,
  unclaimRun,
} from "./repository";
import {
  listDueSchedules,
  scheduleCreatedBy,
  updateScheduleAfterFire,
} from "./schedules";
import type { CvStrategyJson, DataFiltersJson, SearchSpaceJson } from "./types";

const tag = "OptimizerScheduler";
// 5s tick: gives the Telegram "run started" notification near-real-time
// latency (was up to 30s when this was 30_000). The tick body itself is
// cheap — a couple of indexed SELECTs — so polling 6× more often is
// negligible cost in exchange for a much better operator experience.
// `METRICS_TICK_EVERY` is bumped in lockstep so live-metrics still
// recompute every ~10 minutes, not every ~100 seconds.
const POLL_INTERVAL_MS = 5_000;

interface SchedulerState {
  active: boolean;
  timer: ReturnType<typeof setInterval> | null;
  lastTickAt: number | null;
  lastError: string | null;
  totalKickoffs: number;
  totalScheduleFires: number;
}

const state = singleton<SchedulerState>("optimizer:scheduler", () => ({
  active: false,
  timer: null,
  lastTickAt: null,
  lastError: null,
  totalKickoffs: 0,
  totalScheduleFires: 0,
}));

/**
 * Process schedules whose `next_fire_at` has elapsed: create a fresh
 * `optimization_runs` row from the schedule's snapshot, update the
 * schedule's last_fire / next_fire pointers. The new run row will be
 * picked up by the queue tick below (same loop iteration even).
 */
async function fireDueSchedules(): Promise<void> {
  let due: Awaited<ReturnType<typeof listDueSchedules>>;
  try {
    due = await listDueSchedules();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `listDueSchedules failed: ${msg}`);
    state.lastError = msg;
    return;
  }
  if (due.length === 0) return;

  logger.info(tag, `Found ${due.length} due schedule(s); creating runs`);
  for (const sched of due) {
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      const run = await createRun({
        name: `${sched.name} — ${stamp}`,
        searchAlgorithm: sched.searchAlgorithm as never,
        nTrialsTarget: sched.nTrialsTarget,
        cvStrategy: sched.cvStrategy as Partial<CvStrategyJson>,
        searchSpace: sched.searchSpace as SearchSpaceJson,
        dataFilters: sched.dataFilters as DataFiltersJson,
        notifyOnComplete: sched.notifyOnComplete,
        notifyOnStart: sched.notifyOnStart,
        createdBy: scheduleCreatedBy(sched.id),
      });
      await updateScheduleAfterFire(sched.id, run.id);
      state.totalScheduleFires += 1;
      logger.info(
        tag,
        `Schedule ${sched.id} (${sched.name}) fired → run ${run.id}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(tag, `Schedule ${sched.id} fire failed: ${msg}`);
      state.lastError = msg;
    }
  }
}

// Live-metrics aggregator runs every Nth tick. With POLL_INTERVAL_MS=5s,
// N=120 → recompute every 10 minutes (the same wall-clock cadence as the
// previous 30s × 20 setup).
const METRICS_TICK_EVERY = 120;
let tickCounter = 0;

async function tick(): Promise<void> {
  state.lastTickAt = Date.now();
  tickCounter += 1;

  // 0. Reconcile any rows stuck in `running` with no Job behind them.
  //    This is the safety net for crashes between claimQueuedRun and
  //    triggerJobExecution — neither inline rollback path runs in that
  //    case. Reverts rows to `queued` so step 4 below can retry them.
  try {
    const reverted = await reconcileStuckClaims();
    if (reverted.length > 0) {
      logger.warn(
        tag,
        `Reconciled ${reverted.length} stuck claim(s) → queued: ${reverted.join(", ")}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `reconcileStuckClaims failed: ${msg}`);
  }

  // 1. Fire any schedules whose time has come — they create rows that the
  //    queue step below picks up in the same tick.
  await fireDueSchedules();

  // 2. Recompute per-strategy live metrics every Nth tick. Cheap query but
  //    not worth doing every 30s when 10min granularity is plenty.
  if (tickCounter % METRICS_TICK_EVERY === 0) {
    try {
      await recomputeLiveMetrics();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(tag, `recomputeLiveMetrics failed: ${msg}`);
    }
  }

  // 3a. Telegram "run started" ping — once the sidecar sets started_at.
  //     At-most-once via `optimization_runs.started_notified_at`.
  try {
    await processPendingRunStartedNotifications();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `processPendingRunStartedNotifications failed: ${msg}`);
  }

  // 3b. Telegram notification for runs that just hit a terminal status.
  //     At-most-once delivery guaranteed by `optimization_runs.notified_at`.
  try {
    await processPendingRunNotifications();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `processPendingRunNotifications failed: ${msg}`);
  }

  // 4. Trigger a Cloud Run Job execution for every queued run.
  //    Atomic claim: `claimQueuedRun` flips status='queued'→'running' in a
  //    single UPDATE; only the winning caller actually triggers the Job, so
  //    a concurrent immediate-kick from `kickRunNow` can't double-fire.
  try {
    const queued = await listQueuedRuns();
    if (queued.length === 0) return;

    logger.info(tag, `Found ${queued.length} queued run(s); triggering Jobs`);
    for (const run of queued) {
      const claimed = await claimQueuedRun(run.id);
      if (!claimed) {
        // Another caller (e.g. POST /api/optimizer/runs immediate kick) won
        // the race and already triggered the Job. Nothing to do.
        continue;
      }
      try {
        await triggerJobExecution(run.id);
        state.totalKickoffs += 1;
      } catch (err) {
        // Trigger failed AFTER we won the claim — the row is now `running`
        // but no Job is behind it. Revert to `queued` so the next tick can
        // retry; otherwise the row would sit stuck forever (listQueuedRuns
        // only returns status='queued').
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          tag,
          `Failed to trigger run ${run.id} after claim; reverting to queued: ${msg}`,
        );
        state.lastError = msg;
        try {
          await unclaimRun(run.id);
        } catch (revertErr) {
          const revertMsg =
            revertErr instanceof Error ? revertErr.message : String(revertErr);
          logger.warn(
            tag,
            `Failed to revert claim for run ${run.id}: ${revertMsg}`,
          );
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `Tick error: ${msg}`);
    state.lastError = msg;
  }
}

export function startOptimizerScheduler(): void {
  if (state.active) return;
  state.active = true;
  state.timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  logger.info(tag, `Started (poll every ${POLL_INTERVAL_MS / 1000}s)`);
  // Fire one tick immediately on startup.
  void tick();
}

export function stopOptimizerScheduler(): void {
  if (!state.active) return;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.active = false;
  logger.info(tag, "Stopped");
}

export function isOptimizerSchedulerActive(): boolean {
  return state.active;
}

export function getOptimizerSchedulerStatus(): {
  active: boolean;
  lastTickAt: number | null;
  lastError: string | null;
  totalKickoffs: number;
  totalScheduleFires: number;
} {
  return {
    active: state.active,
    lastTickAt: state.lastTickAt,
    lastError: state.lastError,
    totalKickoffs: state.totalKickoffs,
    totalScheduleFires: state.totalScheduleFires,
  };
}

/**
 * Kicks a single run immediately (called from POST /api/optimizer/runs so
 * the user doesn't wait up to 5s for the next poll). Atomic-claims the
 * row before triggering so concurrent ticks/kicks can't double-fire.
 *
 * If the trigger fails after the claim, we revert `running` → `queued` so
 * the scheduler tick will retry. Without this rollback, a transient ADC /
 * Cloud Run Admin API failure would leave the row stuck in `running` with
 * no Job behind it and no recovery path (listQueuedRuns only returns
 * status='queued').
 */
export async function kickRunNow(runId: string): Promise<void> {
  const claimed = await claimQueuedRun(runId);
  if (!claimed) {
    // Already claimed by the scheduler tick — Job is in flight or running.
    logger.info(tag, `Run ${runId} already claimed; skipping immediate kick`);
    return;
  }
  try {
    await triggerJobExecution(runId);
    state.totalKickoffs += 1;
    logger.info(tag, `Run ${runId} kicked immediately`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      tag,
      `Immediate kick failed for ${runId}; reverting claim so scheduler retries: ${msg}`,
    );
    try {
      await unclaimRun(runId);
    } catch (revertErr) {
      const revertMsg =
        revertErr instanceof Error ? revertErr.message : String(revertErr);
      logger.warn(tag, `Failed to revert claim for ${runId}: ${revertMsg}`);
    }
  }
}
