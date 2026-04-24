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
import { listQueuedRuns } from "./repository";

const tag = "OptimizerScheduler";
const POLL_INTERVAL_MS = 30_000;

interface SchedulerState {
  active: boolean;
  timer: ReturnType<typeof setInterval> | null;
  lastTickAt: number | null;
  lastError: string | null;
  totalKickoffs: number;
}

const state = singleton<SchedulerState>("optimizer:scheduler", () => ({
  active: false,
  timer: null,
  lastTickAt: null,
  lastError: null,
  totalKickoffs: 0,
}));

async function tick(): Promise<void> {
  state.lastTickAt = Date.now();
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
} {
  return {
    active: state.active,
    lastTickAt: state.lastTickAt,
    lastError: state.lastError,
    totalKickoffs: state.totalKickoffs,
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
