/**
 * Reactive Value Detector
 *
 * Event-driven replacement for the 30-second timer-gated detection in syncOddsOnly().
 * Triggers value detection within 500ms of any odds change, rather than waiting
 * for a batch cycle.
 *
 * Architecture:
 *   1. setOdds() in store.ts fires onDirtyCallback on every value change
 *   2. This module debounces those signals at DETECTION_DEBOUNCE_MS (500ms)
 *   3. When the debounce fires, it runs the same detection pipeline:
 *      consumeDirtyFamilies → detectAllValueBetsIncremental → persist → auto-place → SSE
 *   4. A mutex prevents concurrent passes; queued signals fire one follow-up pass
 *   5. A 30s heartbeat acts as a safety net to flush any orphaned dirty families
 *
 * Memory-safe: no accumulation. The dirty set is consumed every pass.
 * Thread-safe: single-threaded JS + mutex flag = no races.
 */

import { singleton } from "@/lib/util/singleton";
import { logger } from "@/lib/shared/logger";
import {
  DETECTION_DEBOUNCE_MS,
  HEARTBEAT_INTERVAL_MS,
  STALE_ODDS_CLEANUP_INTERVAL_MS,
} from "@/lib/shared/constants";
import {
  consumeDirtyFamilies,
  hasDirtyFamilies,
  setOnDirtyCallback,
  getStoreStats,
  pruneOddsForStaleEvents,
} from "@/lib/atoms/store";
import { pruneHistoryForEvents } from "@/lib/atoms/odds-history";
import { detectAllValueBetsIncremental } from "@/lib/atoms/value-detector";
import { persistValueBets } from "@/lib/db/repositories/bets";
import { getBettingSettings } from "@/lib/db/repositories/betting-settings";
import { maybeAutoPlace } from "@/lib/betting/auto-placer";
import {
  getMatchedEvents,
  setValueBets,
  getValueBets as storeGetValueBets,
  setSyncStatus,
} from "@/lib/store";
import { invalidateResponseCache } from "@/lib/cache/response-cache";
import { computeDelta } from "@/lib/cache/delta";
import { syncBus } from "@/lib/events/event-bus";
import { buildMovementSnapshot } from "@/lib/atoms/odds-history";

// ============================================
// State — singleton for HMR safety
// ============================================

const state = singleton("reactive-detector:state", () => ({
  running: false,
  debounceTimer: null as ReturnType<typeof setTimeout> | null,
  heartbeatTimer: null as ReturnType<typeof setInterval> | null,
  cleanupTimer: null as ReturnType<typeof setInterval> | null,
  /** True when a detection pass is currently executing. */
  passInProgress: false,
  /** True when more dirty families arrived during the current pass. */
  needsAnotherPass: false,
  // Stats
  totalPasses: 0,
  totalDirtyFamilies: 0,
  totalValueBetsFound: 0,
  totalPassDurationMs: 0,
  lastPassAt: null as number | null,
}));

/**
 * Per-bet change-detection cache.
 * Tracks the odds last written to DB for each bet ID so we can skip
 * the upsert (and auto-place, movement snapshot) entirely when the
 * bet's terms haven't changed. Lost on restart — first post-restart
 * pass writes everything, subsequent passes dedup. ~100 bytes per
 * entry, trivial memory for <100 active value bets.
 */
interface PersistedSnapshot {
  sharpOdds: number;
  softOdds: number;
  softProvider: string;
}
const lastPersisted = singleton(
  "reactive-detector:lastPersisted",
  (): Map<string, PersistedSnapshot> => new Map(),
);

// ============================================
// Core detection pass
// ============================================

async function runDetectionPass(): Promise<void> {
  if (state.passInProgress) {
    // Another pass will run after the current one finishes
    state.needsAnotherPass = true;
    return;
  }

  state.passInProgress = true;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      state.needsAnotherPass = false;

      const dirty = consumeDirtyFamilies();
      if (dirty.size === 0) break;

      const passStart = Date.now();

      // Pre-match filter: only detect value on events before kickoff
      const nowMs = Date.now();
      const preMatchEventIds = getMatchedEvents()
        .filter((e) => new Date(e.startTime).getTime() > nowMs)
        .map((e) => e.id);

      if (preMatchEventIds.length === 0) {
        logger.debug("ReactiveDetector", "No pre-match events, skipping pass");
        break;
      }

      // Pull Kelly config for sizing
      const { row: bettingSettings } = await getBettingSettings();

      // Run detection
      const valueBets = detectAllValueBetsIncremental(
        preMatchEventIds,
        dirty,
        { kellyFraction: bettingSettings.kellyFraction },
      );

      // Track previous count for change detection
      const prevValueCount = storeGetValueBets().length;

      // Update in-memory store + invalidate caches
      setValueBets(valueBets);
      invalidateResponseCache();

      // ── Application-layer change detection ──────────────────────────
      // Only persist + auto-place bets whose terms actually changed since
      // the last DB write. This is the primary dedup gate (industry-
      // standard write-behind pattern). The SQL-level CASE WHEN guard in
      // bets.ts is kept as defense-in-depth but should rarely trigger.
      const changedBets = valueBets.filter((vb) => {
        // Must be in a dirty family (coarse pre-filter)
        if (!dirty.has(`${vb.eventId}|${vb.familyId}`)) return false;
        // Fine-grained: did THIS bet's terms actually change?
        const prev = lastPersisted.get(vb.id);
        if (!prev) return true; // never persisted → always write
        return (
          prev.sharpOdds !== vb.sharpOdds ||
          prev.softOdds !== vb.softOdds ||
          prev.softProvider !== vb.softProvider
        );
      });

      if (changedBets.length > 0) {
        try {
          // Enrich only changed bets with movement snapshots
          const enrichedBets = changedBets.map((vb) => {
            const snapshot = buildMovementSnapshot(
              vb.eventId,
              vb.familyId,
              vb.atomId,
              vb.sharpProvider,
            );
            return { ...vb, oddsMovement: snapshot ?? undefined };
          });

          const result = await persistValueBets(enrichedBets);

          // Update the last-persisted cache for successfully written bets
          for (const vb of changedBets) {
            lastPersisted.set(vb.id, {
              sharpOdds: vb.sharpOdds,
              softOdds: vb.softOdds,
              softProvider: vb.softProvider,
            });
          }

          if (result.inserted > 0 || result.errors > 0) {
            logger.info(
              "ReactiveDetector",
              `DB: +${result.inserted} new, ~${result.updated} updated` +
                (result.errors
                  ? ` (${result.errors} errors${result.lastError ? `: ${result.lastError}` : ""})`
                  : ""),
            );
          }
        } catch (err) {
          logger.error(
            "ReactiveDetector",
            `DB persist failed: ${(err as Error).message}`,
          );
        }

        // Auto-place only changed bets (fire-and-forget per bet)
        for (const vb of changedBets) {
          maybeAutoPlace(vb).catch((err) =>
            logger.error(
              "ReactiveDetector",
              `AutoPlace failed for ${vb.id}: ${(err as Error).message}`,
            ),
          );
        }
      }

      // SSE notifications
      const passDuration = Date.now() - passStart;

      syncBus.emitBus({
        type: "sync:complete",
        duration: passDuration,
        valueBetCount: valueBets.length,
        dirtyFamilies: dirty.size,
      });

      const delta = computeDelta(syncBus.version);
      syncBus.emitBus({ type: "data:delta", delta });

      if (valueBets.length !== prevValueCount) {
        syncBus.emitBus({
          type: "value:change",
          added: Math.max(0, valueBets.length - prevValueCount),
          removed: Math.max(0, prevValueCount - valueBets.length),
          total: valueBets.length,
        });
      }

      // Update stats
      state.totalPasses++;
      state.totalDirtyFamilies += dirty.size;
      state.totalValueBetsFound += valueBets.length;
      state.totalPassDurationMs += passDuration;
      state.lastPassAt = Date.now();

      if (dirty.size > 0) {
        logger.info(
          "ReactiveDetector",
          `Pass #${state.totalPasses}: ${dirty.size} dirty → ${valueBets.length} value bets (${passDuration}ms)`,
        );
      }

      // If more changes arrived during this pass, loop again
      if (!state.needsAnotherPass) break;
    }
  } catch (err) {
    logger.error(
      "ReactiveDetector",
      `Detection pass failed: ${(err as Error).message}`,
    );
  } finally {
    state.passInProgress = false;
  }
}

// ============================================
// Debounced trigger (called by onDirtyCallback)
// ============================================

function onDirtySignal(): void {
  if (!state.running) return;

  // If a debounce timer is already ticking, let it coalesce
  if (state.debounceTimer !== null) return;

  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null;
    runDetectionPass().catch((err) =>
      logger.error("ReactiveDetector", `Debounced pass error: ${err}`),
    );
  }, DETECTION_DEBOUNCE_MS);
}

// ============================================
// Heartbeat — safety net + closing capture + cleanup
// ============================================

async function heartbeat(): Promise<void> {
  // 1. Safety net: flush any orphan dirty families
  if (hasDirtyFamilies()) {
    logger.debug("ReactiveDetector", "Heartbeat: flushing orphan dirty families");
    await runDetectionPass();
  }

  // 2. Closing-odds capture for events near kickoff
  try {
    const { captureClosingOdds } = await import("./closing-capture");
    await captureClosingOdds();
  } catch (err) {
    logger.warn(
      "ReactiveDetector",
      `Closing capture failed: ${(err as Error).message}`,
    );
  }

  // 3. Update sync status for UI
  const stats = getStoreStats();
  setSyncStatus({
    isSyncing: false,
    lastSyncEnd: new Date(),
    currentPhase: "idle",
    phaseProgress: null,
    lastMarketsCount: stats.totalOddsRecords,
  });
}

// ============================================
// Memory cleanup — prune stale events
// ============================================

function runStaleCleanup(): void {
  const activeEvents = getMatchedEvents();
  const activeIds = new Set(activeEvents.map((e) => e.id));

  // Prune odds store
  const prunedOdds = pruneOddsForStaleEvents(activeIds);

  // Prune odds history
  const prunedHistory = pruneHistoryForEvents(activeIds);

  if (prunedOdds > 0 || prunedHistory > 0) {
    logger.info(
      "ReactiveDetector",
      `Stale cleanup: pruned ${prunedOdds} odds events, ${prunedHistory} history entries`,
    );
  }
}

// ============================================
// Lifecycle
// ============================================

/**
 * Start the reactive detector. Registers the dirty callback on the atoms store
 * and begins the heartbeat timer.
 */
export function startReactiveDetector(): void {
  if (state.running) {
    logger.debug("ReactiveDetector", "Already running");
    return;
  }

  state.running = true;

  // Register dirty callback on the atoms store
  setOnDirtyCallback(onDirtySignal);

  // Start heartbeat (safety net + closing capture)
  state.heartbeatTimer = setInterval(() => {
    heartbeat().catch((err) =>
      logger.error("ReactiveDetector", `Heartbeat error: ${err}`),
    );
  }, HEARTBEAT_INTERVAL_MS);

  // Start stale event cleanup
  state.cleanupTimer = setInterval(runStaleCleanup, STALE_ODDS_CLEANUP_INTERVAL_MS);

  logger.info(
    "ReactiveDetector",
    `Started (debounce=${DETECTION_DEBOUNCE_MS}ms, heartbeat=${HEARTBEAT_INTERVAL_MS / 1000}s, cleanup=${STALE_ODDS_CLEANUP_INTERVAL_MS / 60_000}min)`,
  );
}

/**
 * Stop the reactive detector. Clears all timers and unregisters the callback.
 */
export function stopReactiveDetector(): void {
  state.running = false;

  // Unregister dirty callback
  setOnDirtyCallback(null);

  // Clear timers
  if (state.debounceTimer !== null) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
  }
  if (state.heartbeatTimer !== null) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
  if (state.cleanupTimer !== null) {
    clearInterval(state.cleanupTimer);
    state.cleanupTimer = null;
  }

  logger.info("ReactiveDetector", "Stopped");
}

/**
 * Manually trigger a detection pass (used by heartbeat and external callers).
 */
export function triggerDetection(): void {
  if (!state.running) return;
  runDetectionPass().catch((err) =>
    logger.error("ReactiveDetector", `Manual trigger error: ${err}`),
  );
}

/**
 * Get diagnostic stats for the reactive detector.
 */
export function getReactiveDetectorStats() {
  return {
    running: state.running,
    totalPasses: state.totalPasses,
    totalDirtyFamilies: state.totalDirtyFamilies,
    totalValueBetsFound: state.totalValueBetsFound,
    avgPassDurationMs:
      state.totalPasses > 0
        ? Math.round(state.totalPassDurationMs / state.totalPasses)
        : 0,
    lastPassAt: state.lastPassAt,
    passInProgress: state.passInProgress,
  };
}
