
import { runAutoSettle, type AutoSettleResult } from "./auto-settler";
import { logger } from "../shared/logger";
import { appendActivity } from "./activity-log";
import { syncBus } from "../events/event-bus";
import { singleton } from "../util/singleton";

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
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
        eventsTotal: result.telemetry.eventsTotal,
        eventsAttempted: result.telemetry.eventsAttempted,
        eventsSkippedByBackoff: result.telemetry.eventsSkippedByBackoff,
        eventsResolvedFromCache: result.telemetry.eventsResolvedFromCache,
        eventsResolvedByEspn: result.telemetry.eventsResolvedByEspn,
        eventsResolvedBySofaScore: result.telemetry.eventsResolvedBySofaScore,
        eventsResolvedByApiFootball:
          result.telemetry.eventsResolvedByApiFootball,
        eventsStillUnresolved: result.telemetry.eventsStillUnresolved,
        apiFootballRequestsUsed: result.telemetry.apiFootballRequestsUsed,
        tier0: result.telemetry.tier0_hits,
        tier1: result.telemetry.tier1_hits,
        tier2: result.telemetry.tier2_hits,
        errors: result.errors,
        sourceIssues: result.sourceIssues,
      },
    );
    if (result.sourceIssues.length > 0) {
      appendActivity(
        "source:degraded",
        "warn",
        result.sourceIssues.join(" · "),
      );
    }
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

export function startAutoSettleScheduler(intervalMs?: number): void {
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

export function isAutoSettleActive(): boolean {
  return state.active;
}

export function isAutoSettlePaused(): boolean {
  return state.paused;
}

export async function triggerAutoSettleNow(): Promise<AutoSettleResult> {
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
  return {
    active: state.active,
    paused: state.paused,
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
