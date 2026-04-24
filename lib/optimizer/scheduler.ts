/**
 * Next.js-side optimizer scheduler.
 *
 * Polls `optimization_runs WHERE status='queued'` every 30s and tells the
 * Python sidecar to start each one. The sidecar owns all status transitions
 * after kickoff — this scheduler is fire-and-forget.
 *
 * Pattern mirrors `lib/settle/scheduler.ts`: singleton state, idempotent
 * (HMR-safe), errors logged + swallowed (don't poison the loop).
 */

import { logger } from "../shared/logger";
import { singleton } from "../util/singleton";
import { startRun } from "./api-client";
import { createRun, listQueuedRuns } from "./repository";
import {
  listDueSchedules,
  scheduleCreatedBy,
  updateScheduleAfterFire,
} from "./schedules";
import type { CvStrategyJson, DataFiltersJson, SearchSpaceJson } from "./types";

const tag = "OptimizerScheduler";
const POLL_INTERVAL_MS = 30_000;

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

async function tick(): Promise<void> {
  state.lastTickAt = Date.now();
  // 1. Fire any schedules whose time has come — they create rows that the
  //    queue step below picks up in the same tick.
  await fireDueSchedules();

  // 2. Kick the sidecar for every queued run.
  try {
    const queued = await listQueuedRuns();
    if (queued.length === 0) return;

    logger.info(tag, `Found ${queued.length} queued run(s); kicking sidecar`);
    for (const run of queued) {
      try {
        await startRun(run.id);
        state.totalKickoffs += 1;
      } catch (err) {
        // Don't crash the loop — sidecar might be down; we'll retry next tick.
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(tag, `Failed to kick run ${run.id}: ${msg}`);
        state.lastError = msg;
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
 * the user doesn't wait up to 30s for the next poll). Failures are silent —
 * the scheduler will retry on its next tick.
 */
export async function kickRunNow(runId: string): Promise<void> {
  try {
    await startRun(runId);
    state.totalKickoffs += 1;
    logger.info(tag, `Run ${runId} kicked immediately`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      tag,
      `Immediate kick failed for ${runId}; will retry on next tick: ${msg}`,
    );
  }
}
