/**
 * Continuous settlement scheduler.
 *
 * Runs `runAutoSettle` on a fixed interval. Lightweight twin of the main
 * sync scheduler in `lib/background/fetcher.ts` — separate concern, so
 * failures in one don't cascade into the other.
 *
 * Concurrency guard: if a tick is still running when the next one fires,
 * the new tick is skipped (not queued). The loop is idempotent — the
 * same bet ids read on two successive ticks would both be resolved by
 * the Tier-0 cache at near-zero cost.
 *
 * Failure policy: any error inside a tick is logged and swallowed. We
 * don't want one bad event to stall settlement for the other 499.
 *
 * UI controls this scheduler via three layers:
 *   - Pause (in-memory)   — timer keeps firing; ticks skipped until resumed.
 *   - Stop / Start        — tears down / rebuilds the timer entirely.
 *   - Kill switch (disk)  — persistent; blocks auto-start on boot.
 */

import { runAutoSettle, type AutoSettleResult } from "./auto-settler";
import { logger } from "../shared/logger";
import { appendActivity } from "./activity-log";
import {
  getKillSwitchState,
  isAutoSettleDisabled,
  setAutoSettleDisabled,
  type KillSwitchState,
} from "./kill-switch";
import { syncBus } from "../events/event-bus";
import { singleton } from "../util/singleton";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MIN_INTERVAL_MS = 30 * 1000;

interface SchedulerState {
  active: boolean;
  paused: boolean;
  intervalMs: number;
  timer: ReturnType<typeof setInterval> | null;
  tickInFlight: boolean;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastResult: AutoSettleResult | null;
  lastError: string | null;
  totalTicks: number;
  totalApplied: number;
  skippedTicks: number;
}

const state = singleton<SchedulerState>("settle:scheduler", () => ({
  active: false,
  paused: false,
  intervalMs: DEFAULT_INTERVAL_MS,
  timer: null,
  tickInFlight: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastResult: null,
  lastError: null,
  totalTicks: 0,
  totalApplied: 0,
  skippedTicks: 0,
}));

export interface AutoSettleStatusSnapshot {
  active: boolean;
  paused: boolean;
  disabled: boolean;
  disabledReason: string | null;
  disabledAt: string | null;
  intervalMs: number;
  tickInFlight: boolean;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastDurationMs: number | null;
  lastResult: AutoSettleResult | null;
  lastError: string | null;
  totalTicks: number;
  totalApplied: number;
  skippedTicks: number;
  /**
   * Count of pending bets currently eligible for the next tick
   * (outcome='pending' AND kickoff > NOW-2h15m). Populated by the
   * GET /api/bets-history/auto-settle route — matches the number users
   * see under the "Ready to settle" tab.
   */
  queuedCount?: number;
}

const resolveInterval = (requested?: number): number => {
  if (requested && requested > 0) return Math.max(requested, MIN_INTERVAL_MS);
  const envRaw = process.env.AUTO_SETTLE_INTERVAL_MS;
  const fromEnv = envRaw ? Number(envRaw) : NaN;
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.max(fromEnv, MIN_INTERVAL_MS);
  }
  return DEFAULT_INTERVAL_MS;
};

function emitState(): void {
  syncBus.emitBus({ type: "settle:state", status: getAutoSettleStatus() });
}

const runTick = async (options?: { manual?: boolean }): Promise<void> => {
  if (state.tickInFlight) {
    state.skippedTicks += 1;
    logger.debug("AutoSettle", "Skipping tick — previous run still in flight.");
    appendActivity(
      "tick:skipped",
      "debug",
      "Tick skipped — previous run still in flight.",
    );
    return;
  }
  if (!options?.manual && isAutoSettleDisabled()) {
    return; // hard off — no activity logged for scheduled ticks once killed
  }
  if (!options?.manual && state.paused) {
    state.skippedTicks += 1;
    return;
  }
  state.tickInFlight = true;
  state.lastStartedAt = Date.now();
  appendActivity(
    "tick:start",
    "info",
    options?.manual ? "Manual tick started." : "Scheduled tick started.",
  );
  emitState();
  try {
    const result = await runAutoSettle();
    state.lastResult = result;
    state.lastError = null;
    state.totalApplied += result.applied;
    appendActivity(
      "tick:end",
      result.errors.length > 0 ? "warn" : "info",
      `Tick complete — scanned ${result.scannedBets}, settled ${result.settled}, applied ${result.applied}, still pending ${result.stillPending}.`,
      {
        scanned: result.scannedBets,
        settled: result.settled,
        applied: result.applied,
        stillPending: result.stillPending,
        durationMs: result.telemetry.durationMs,
        tier0: result.telemetry.tier0_hits,
        tier1: result.telemetry.tier1_hits,
        tier2: result.telemetry.tier2_hits,
        tier3: result.telemetry.tier3_hits,
        tier4: result.telemetry.tier4_hits,
        errors: result.errors,
      },
    );
  } catch (err) {
    const msg = (err as Error).message;
    state.lastError = msg;
    logger.error("AutoSettle", `Tick failed: ${msg}`);
    appendActivity("tick:error", "error", `Tick failed: ${msg}`);
  } finally {
    state.tickInFlight = false;
    state.lastFinishedAt = Date.now();
    state.totalTicks += 1;
    emitState();
  }
};

/**
 * Start the loop. Runs one tick immediately so we don't wait a full
 * interval after process start to settle freshly-finished matches.
 *
 * Respects the persistent kill switch — if an operator disabled the
 * job from the UI, a redeploy must not silently bring it back. Call
 * `enableAutoSettleScheduler()` (or the API `action: "enable"`) first.
 */
export function startAutoSettleScheduler(intervalMs?: number): void {
  if (isAutoSettleDisabled()) {
    logger.info(
      "AutoSettle",
      "Scheduler kill-switch engaged — refusing to start.",
    );
    appendActivity(
      "state:start",
      "warn",
      "Start refused — kill switch is engaged.",
    );
    return;
  }
  if (state.active) {
    logger.info("AutoSettle", "Scheduler already running — ignoring start.");
    return;
  }
  const interval = resolveInterval(intervalMs);
  state.intervalMs = interval;
  state.active = true;
  state.paused = false;
  appendActivity(
    "state:start",
    "info",
    `Scheduler started at ${Math.round(interval / 1000)}s interval.`,
  );
  // Fire-and-forget immediate tick.
  void runTick();
  state.timer = setInterval(() => void runTick(), interval);
  logger.info(
    "AutoSettle",
    `Scheduler started at ${Math.round(interval / 1000)}s interval.`,
  );
  emitState();
}

export function stopAutoSettleScheduler(): void {
  if (!state.active) return;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.active = false;
  state.paused = false;
  logger.info("AutoSettle", "Scheduler stopped.");
  appendActivity("state:stop", "info", "Scheduler stopped.");
  emitState();
}

export function restartAutoSettleScheduler(intervalMs?: number): void {
  stopAutoSettleScheduler();
  startAutoSettleScheduler(intervalMs);
}

export function pauseAutoSettleScheduler(): void {
  if (!state.active || state.paused) return;
  state.paused = true;
  logger.info("AutoSettle", "Scheduler paused — ticks will be skipped.");
  appendActivity("state:pause", "info", "Scheduler paused.");
  emitState();
}

export function resumeAutoSettleScheduler(): void {
  if (!state.paused) return;
  state.paused = false;
  logger.info("AutoSettle", "Scheduler resumed.");
  appendActivity("state:resume", "info", "Scheduler resumed.");
  emitState();
}

/**
 * Engage the persistent kill switch and stop the scheduler. Survives
 * process restarts — a fresh boot will see the switch and refuse to
 * auto-start until `enableAutoSettleScheduler` is called.
 */
export function disableAutoSettleScheduler(reason?: string): KillSwitchState {
  const next = setAutoSettleDisabled(true, reason ?? null);
  stopAutoSettleScheduler();
  logger.warn(
    "AutoSettle",
    `Scheduler disabled via kill switch${reason ? ` — ${reason}` : ""}.`,
  );
  appendActivity(
    "state:disable",
    "warn",
    `Kill switch engaged${reason ? ` — ${reason}` : ""}.`,
    reason ? { reason } : undefined,
  );
  emitState();
  return next;
}

/**
 * Release the persistent kill switch. Does *not* auto-start the
 * scheduler — the caller (usually the API route) decides whether
 * to also start it, so a user can lift the switch without immediately
 * resuming settlement.
 */
export function enableAutoSettleScheduler(): KillSwitchState {
  const next = setAutoSettleDisabled(false, null);
  logger.info("AutoSettle", "Kill switch lifted.");
  appendActivity("state:enable", "info", "Kill switch lifted.");
  emitState();
  return next;
}

export function isAutoSettleActive(): boolean {
  return state.active;
}

export function isAutoSettlePaused(): boolean {
  return state.paused;
}

/**
 * Manually kick off one tick outside the scheduled cadence. Returns the
 * result or the error that killed the tick. Used by the manual-trigger
 * API route and by shell scripts. Respects the kill switch but bypasses
 * pause (operators explicitly asked for a run).
 */
export async function triggerAutoSettleNow(): Promise<AutoSettleResult> {
  if (isAutoSettleDisabled()) {
    throw new Error(
      "Auto-settle is disabled via kill switch — enable it first.",
    );
  }
  if (state.tickInFlight) {
    throw new Error("A settlement tick is already in flight — try again soon.");
  }
  appendActivity("manual:run", "info", "Manual run-now triggered.");
  await runTick({ manual: true });
  if (state.lastError) throw new Error(state.lastError);
  if (!state.lastResult)
    throw new Error("Tick completed with no recorded result.");
  return state.lastResult;
}

export function getAutoSettleStatus(): AutoSettleStatusSnapshot {
  const lastDurationMs =
    state.lastStartedAt && state.lastFinishedAt
      ? state.lastFinishedAt - state.lastStartedAt
      : null;
  const ks = getKillSwitchState();
  return {
    active: state.active,
    paused: state.paused,
    disabled: ks.disabled,
    disabledReason: ks.reason,
    disabledAt: ks.updatedAt,
    intervalMs: state.intervalMs,
    tickInFlight: state.tickInFlight,
    lastStartedAt: state.lastStartedAt,
    lastFinishedAt: state.lastFinishedAt,
    lastDurationMs,
    lastResult: state.lastResult,
    lastError: state.lastError,
    totalTicks: state.totalTicks,
    totalApplied: state.totalApplied,
    skippedTicks: state.skippedTicks,
  };
}
