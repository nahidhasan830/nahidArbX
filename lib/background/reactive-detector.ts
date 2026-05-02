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
  getAllOddsForAtom,
} from "@/lib/atoms/store";
import { pruneHistoryForEvents, getHistoryStats } from "@/lib/atoms/odds-history";
import { cleanupOldScores, getScoreCount, getCornersScoreCount } from "@/lib/scores/store";
import { cleanupOldMultiScores, getMultiScoreCount } from "@/lib/scores/multi-source-store";
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
import { extractFeatures } from "@/lib/ml/features";
import { scoreBatch } from "@/lib/ml/scorer";
import { computeAdjustedKelly } from "@/lib/ml/staker";

// ============================================
// State — singleton for HMR safety
// ============================================

/** How often to emit heap + store-size telemetry (ms). */
const MEMORY_TELEMETRY_INTERVAL_MS = 60_000; // 1 min

/** Heap-usage fractions that trigger WARN / ERROR log levels. */
const HEAP_WARN_RATIO = 0.70;
const HEAP_ERROR_RATIO = 0.85;

const state = singleton("reactive-detector:state", () => ({
  running: false,
  debounceTimer: null as ReturnType<typeof setTimeout> | null,
  heartbeatTimer: null as ReturnType<typeof setInterval> | null,
  cleanupTimer: null as ReturnType<typeof setInterval> | null,
  memoryTimer: null as ReturnType<typeof setInterval> | null,
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
        // ── ML feature extraction ──────────────────────────────────
        // Compute 23-dim feature vectors for each changed bet.
        // Feature extraction failure must never block detection.
        const featuresMap = new Map<string, number[]>();
        const featureStart = Date.now();
        for (const vb of changedBets) {
          try {
            featuresMap.set(vb.id, extractFeatures(vb));
          } catch {
            // Feature extraction failure must never block detection
          }
        }
        const featureMs = Date.now() - featureStart;
        if (featureMs > 10) logger.warn("ReactiveDetector", `Feature extraction slow: ${featureMs}ms`);

        // ── ML scoring ────────────────────────────────────────────
        // Batch-score all bets with available features through the
        // ONNX model. Without a model, scoreBatch returns 1.0 for
        // all (pass-through). Score ALL bets — low-score bets are
        // still valuable training data. Filtering happens at the
        // auto-placer gate only.
        const scoresMap = new Map<string, number>();
        const kellyMap = new Map<string, number>();
        try {
          const featureArrays: number[][] = [];
          const betIds: string[] = [];
          for (const vb of changedBets) {
            const features = featuresMap.get(vb.id);
            if (features) {
              featureArrays.push(features);
              betIds.push(vb.id);
            }
          }
          if (featureArrays.length > 0) {
            const scores = await scoreBatch(featureArrays);
            for (let i = 0; i < betIds.length; i++) {
              const betId = betIds[i];
              const score = scores[i];
              scoresMap.set(betId, score);
              // Compute adjusted Kelly for this bet
              const vb = changedBets.find((b) => b.id === betId);
              if (vb) {
                const features = featuresMap.get(betId)!;
                kellyMap.set(betId, computeAdjustedKelly(vb.kellyFraction, score, features));
              }
            }
          }
        } catch (err) {
          // Scoring failure must never block detection
          logger.warn("ReactiveDetector", `ML scoring failed: ${(err as Error).message}`);
        }

        try {
          // Enrich only changed bets with movement snapshots from all active providers
          const enrichedBets = changedBets.map((vb) => {
            const allOdds = getAllOddsForAtom(vb.eventId, vb.familyId, vb.atomId);
            const snapshots: Record<string, import("@/lib/bets-history/types").OddsMovementData> = {};
            
            // For every provider that has odds for this atom, try to build a movement snapshot
            if (allOdds) {
              for (const provider of allOdds.keys()) {
                const snapshot = buildMovementSnapshot(
                  vb.eventId,
                  vb.familyId,
                  vb.atomId,
                  provider,
                );
                if (snapshot) {
                  snapshots[provider] = snapshot;
                }
              }
            }

            // Fallback: If no providers were matched (should be rare), try at least the sharp provider
            if (Object.keys(snapshots).length === 0) {
              const sharpSnapshot = buildMovementSnapshot(
                vb.eventId,
                vb.familyId,
                vb.atomId,
                vb.sharpProvider,
              );
              if (sharpSnapshot) {
                snapshots[vb.sharpProvider] = sharpSnapshot;
              }
            }

            return { 
              ...vb, 
              oddsMovement: Object.keys(snapshots).length > 0 ? snapshots : undefined,
              mlFeatures: featuresMap.get(vb.id) ?? null,
              mlScore: scoresMap.get(vb.id) ?? null,
              mlKellyAdjusted: kellyMap.get(vb.id) ?? null,
            };
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
        // Pass ML score + adjusted Kelly so the placer can use them
        for (const vb of changedBets) {
          const mlScore = scoresMap.get(vb.id);
          const mlKellyAdjusted = kellyMap.get(vb.id);
          maybeAutoPlace(vb, mlScore ?? undefined, mlKellyAdjusted ?? undefined).catch((err) =>
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
// Memory telemetry — periodic heap + store watchdog
// ============================================

/**
 * Logs heap usage and all in-memory store cardinalities every minute.
 * Emits WARN at 70% heap and ERROR at 85% so we catch leaks long
 * before they snowball into an OOM crash.
 */
function logMemoryTelemetry(): void {
  const mem = process.memoryUsage();
  const heapUsedMB = mem.heapUsed / 1024 / 1024;
  const heapTotalMB = mem.heapTotal / 1024 / 1024;
  const rssMB = mem.rss / 1024 / 1024;
  const externalMB = mem.external / 1024 / 1024;
  const heapRatio = mem.heapUsed / mem.heapTotal;

  // Gather store cardinalities
  const storeStats = getStoreStats();
  const histStats = getHistoryStats();
  const valueBetCount = storeGetValueBets().length;
  const scoreCount = getScoreCount();
  const cornersCount = getCornersScoreCount();
  const multiScoreCount = getMultiScoreCount();
  const dedupCacheSize = lastPersisted.size;

  const line =
    `heap=${heapUsedMB.toFixed(0)}/${heapTotalMB.toFixed(0)}MB (${(heapRatio * 100).toFixed(0)}%) ` +
    `rss=${rssMB.toFixed(0)}MB ext=${externalMB.toFixed(0)}MB | ` +
    `odds: ${storeStats.totalOddsRecords} atoms, ${storeStats.eventCount} events | ` +
    `history: ${histStats.trackedAtoms} entries ≈${(histStats.memoryEstimateBytes / 1024 / 1024).toFixed(1)}MB | ` +
    `scores: ${scoreCount} live, ${cornersCount} corners, ${multiScoreCount} multi | ` +
    `valueBets=${valueBetCount} dedup=${dedupCacheSize} | ` +
    `passes=${state.totalPasses}`;

  if (heapRatio >= HEAP_ERROR_RATIO) {
    logger.error("MemoryWatch", `CRITICAL: ${line}`);
  } else if (heapRatio >= HEAP_WARN_RATIO) {
    logger.warn("MemoryWatch", `HIGH: ${line}`);
  } else {
    logger.info("MemoryWatch", line);
  }
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

  // Prune score stores — these were never cleaned up, growing unboundedly
  const prunedScores = cleanupOldScores(3 * 60 * 60 * 1000); // 3h
  const prunedMultiScores = cleanupOldMultiScores(3 * 60 * 60 * 1000); // 3h

  // Prune the lastPersisted dedup cache — remove entries for bets
  // that no longer exist in the active value-bet set
  let prunedDedup = 0;
  const currentBetIds = new Set(storeGetValueBets().map((vb) => vb.id));
  for (const betId of lastPersisted.keys()) {
    if (!currentBetIds.has(betId)) {
      lastPersisted.delete(betId);
      prunedDedup++;
    }
  }

  const totalPruned =
    prunedOdds + prunedHistory + prunedScores + prunedMultiScores + prunedDedup;
  if (totalPruned > 0) {
    const histStats = getHistoryStats();
    logger.info(
      "ReactiveDetector",
      `Stale cleanup: odds=${prunedOdds} history=${prunedHistory} scores=${prunedScores} multiScores=${prunedMultiScores} dedup=${prunedDedup} | historyMem≈${(histStats.memoryEstimateBytes / 1024 / 1024).toFixed(1)}MB`,
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

  // Start memory telemetry watchdog (every 60s)
  state.memoryTimer = setInterval(logMemoryTelemetry, MEMORY_TELEMETRY_INTERVAL_MS);

  // Log initial memory baseline
  logMemoryTelemetry();

  logger.info(
    "ReactiveDetector",
    `Started (debounce=${DETECTION_DEBOUNCE_MS}ms, heartbeat=${HEARTBEAT_INTERVAL_MS / 1000}s, cleanup=${STALE_ODDS_CLEANUP_INTERVAL_MS / 60_000}min, memWatch=${MEMORY_TELEMETRY_INTERVAL_MS / 1000}s)`,
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
  if (state.memoryTimer !== null) {
    clearInterval(state.memoryTimer);
    state.memoryTimer = null;
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
