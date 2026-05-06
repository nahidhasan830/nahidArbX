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
 * Phase 8 ML integration:
 *   - Features are extracted for ALL detected value bets (training data)
 *   - Scoring runs through the ONNX model (returns null when no model loaded)
 *   - Permission-aware staking via `computeScoredStake()` respects the
 *     deployment gate (shadow/gate_only/stake_reduce/stake_increase)
 *   - Shadow decisions are logged for offline analysis
 *
 * Phase 9 near-miss + shadow data:
 *   - Shadow-scored detection snapshots stored for every value bet (outcome later)
 *   - Near-miss atoms (0.5% ≤ EV% < MIN_EV_PCT) collected as lower-weight
 *     negative training examples to reduce survival bias
 *   - Rate-limited per bet key (10min cooldown) and capped per pass (5 max)
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
  NEAR_MISS_MAX_PER_PASS,
  NEAR_MISS_COOLDOWN_MS,
} from "@/lib/shared/constants";
import {
  consumeDirtyFamilies,
  hasDirtyFamilies,
  setOnDirtyCallback,
  getStoreStats,
  pruneOddsForStaleEvents,
  getAllOddsForAtom,
  getFamiliesForEvent,
} from "@/lib/atoms/store";
import { pruneHistoryForEvents, getHistoryStats } from "@/lib/atoms/odds-history";
import { cleanupOldScores, getScoreCount, getCornersScoreCount } from "@/lib/scores/store";
import { cleanupOldMultiScores, getMultiScoreCount } from "@/lib/scores/multi-source-store";
import { detectAllValueBetsIncremental, detectNearMissesForFamily } from "@/lib/atoms/value-detector";
import type { NearMissBet } from "@/lib/atoms/value-detector";
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
import { scoreBatch, isModelLoaded } from "@/lib/ml/scorer";
import { computeScoredStake, computeAdjustedKelly } from "@/lib/ml/staker";
import { logShadowDecision, SHADOW_KELLY_MULTIPLIER } from "@/lib/ml/shadow-mode";
import { getPermissionLevel } from "@/lib/ml/deployment-gate";
import { writeDetectionSnapshot, writeNearMissExamples } from "@/lib/ml/training-example-writer";

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

/**
 * Near-miss rate-limit cache: bet key → last-written timestamp.
 * Prevents writing the same near-miss more than once per NEAR_MISS_COOLDOWN_MS.
 * Pruned alongside the dedup cache during stale cleanup.
 */
const nearMissLastWritten = singleton(
  "reactive-detector:nearMissLastWritten",
  (): Map<string, number> => new Map(),
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
        // Compute 25-dim feature vectors for each changed bet.
        // Feature extraction failure must never block detection.

        // Build event → market count map for feature[24] (num_markets_same_event)
        const eventMarketCounts = new Map<string, number>();
        for (const vb of valueBets) {
          eventMarketCounts.set(vb.eventId, (eventMarketCounts.get(vb.eventId) ?? 0) + 1);
        }

        const featuresMap = new Map<string, number[]>();
        const featureStart = Date.now();
        let fqMissingEvent = 0;
        let fqMissingHistory = 0;
        let fqMissingVig = 0;
        for (const vb of changedBets) {
          try {
            const f = extractFeatures(vb, eventMarketCounts.get(vb.eventId));
            featuresMap.set(vb.id, f);
            // Feature quality tracking (indexes: 5=tick_count, 6=time_to_kickoff, 16=opening_sharp, 20=vig_pct)
            if (f[6] === 0 && f[5] === 0 && f[16] === 0) fqMissingEvent++;
            if (f[5] === 0 && f[16] === 0) fqMissingHistory++;
            if (f[20] === 0) fqMissingVig++;
          } catch {
            // Feature extraction failure must never block detection
          }
        }
        const featureMs = Date.now() - featureStart;
        if (featureMs > 10 || fqMissingEvent > 0 || fqMissingVig > 0) {
          logger.info(
            "ReactiveDetector",
            `Features: ${featuresMap.size}/${changedBets.length} ok, ${featureMs}ms` +
              (fqMissingEvent ? ` | missingEvent=${fqMissingEvent}` : "") +
              (fqMissingHistory ? ` | missingHistory=${fqMissingHistory}` : "") +
              (fqMissingVig ? ` | missingVig=${fqMissingVig}` : ""),
          );
        }

        // ── ML scoring ────────────────────────────────────────────
        // Batch-score all bets with available features through the
        // ONNX model. Without a model, scoreBatch returns null for
        // all (pass-through). Score ALL bets — low-score bets are
        // still valuable training data. Filtering happens at the
        // auto-placer gate only.
        //
        // Phase 8: Read the deployment gate permission level to
        // determine how scores affect staking.
        const permissionLevel = getPermissionLevel();
        const modelActive = isModelLoaded();
        const scoresMap = new Map<string, number | null>();
        const kellyMap = new Map<string, number | null>();
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

              // Permission-aware staking: computeScoredStake respects
              // the deployment gate level. Returns null when ML should
              // not affect staking (shadow mode or no model).
              const vb = changedBets.find((b) => b.id === betId);
              if (vb) {
                const features = featuresMap.get(betId)!;
                const adjusted = computeScoredStake(
                  vb.kellyFraction,
                  score,
                  features,
                  permissionLevel,
                );
                kellyMap.set(betId, adjusted);
              }
            }
          }
        } catch (err) {
          // Scoring failure must never block detection
          logger.warn("ReactiveDetector", `ML scoring failed: ${(err as Error).message}`);
        }

        // Log scoring mode on first pass with a model
        if (modelActive && state.totalPasses === 0) {
          logger.info(
            "ReactiveDetector",
            `ML scoring active — permission=${permissionLevel}, model loaded`,
          );
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

            // Resolve ML score and Kelly for persistence.
            // The score is always persisted (even in shadow mode) for training data.
            // The Kelly adjustment is only persisted when the permission level allows it.
            const rawScore = scoresMap.get(vb.id);
            const adjustedKelly = kellyMap.get(vb.id);

            return { 
              ...vb, 
              oddsMovement: Object.keys(snapshots).length > 0 ? snapshots : undefined,
              mlFeatures: featuresMap.get(vb.id) ?? null,
              mlScore: rawScore ?? null,
              // Only persist ML-adjusted Kelly when permission level actually modifies it
              mlKellyAdjusted: adjustedKelly ?? null,
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

        // Auto-place only changed bets (fire-and-forget per bet).
        // Pass the permission-aware adjusted Kelly so the placer uses
        // the correct stake. When adjustedKelly is null (shadow mode or
        // no model), the placer falls back to base Kelly.
        for (const vb of changedBets) {
          const rawScore = scoresMap.get(vb.id);
          const adjustedKelly = kellyMap.get(vb.id);

          // Only pass score to auto-placer when the permission level
          // allows gating (gate_only or higher). In shadow mode, we
          // don't want the placer's ML gate to activate.
          const scoreForPlacer = permissionLevel === "shadow"
            ? undefined
            : (rawScore ?? undefined);
          const kellyForPlacer = adjustedKelly ?? undefined;

          maybeAutoPlace(vb, scoreForPlacer, kellyForPlacer).catch((err) =>
            logger.error(
              "ReactiveDetector",
              `AutoPlace failed for ${vb.id}: ${(err as Error).message}`,
            ),
          );

          // Shadow-mode logging: always log when a model is active,
          // regardless of permission level (for offline A/B analysis)
          if (modelActive && rawScore != null) {
            const features = featuresMap.get(vb.id);
            if (features) {
              const mlKelly = computeAdjustedKelly(vb.kellyFraction, rawScore, features);
              logShadowDecision({
                betId: vb.id,
                eventId: vb.eventId,
                kellyFraction: vb.kellyFraction,
                shadowKelly: vb.kellyFraction * SHADOW_KELLY_MULTIPLIER,
                mlKelly,
                mlMultiplier: vb.kellyFraction > 0 ? mlKelly / vb.kellyFraction : 0,
                placedAt: new Date(),
              }).catch(() => {}); // fire-and-forget
            }
          }
        }

        // ── Phase 9: Shadow-scored detection snapshots ────────────────
        // Store a feature snapshot for every detected value bet so we can
        // later attach outcome/CLV when the bet settles. This builds the
        // shadow_scored training examples dataset.
        for (const vb of changedBets) {
          const features = featuresMap.get(vb.id);
          if (features) {
            writeDetectionSnapshot(
              vb.id,
              vb.eventId,
              vb.familyId,
              vb.atomId,
              features,
            ).catch(() => {}); // fire-and-forget
          }
        }

        // ── Phase 9: Near-miss collection ─────────────────────────────
        // Collect sub-threshold edges (0.5% ≤ EV% < MIN_EV_PCT) from
        // dirty families as lower-weight negative training examples.
        // Rate-limited per bet key and capped per pass.
        const now9 = Date.now();
        const nearMissCandidates: NearMissBet[] = [];
        const dirtyEventIds = new Set<string>();
        for (const dirtyKey of dirty) {
          const parts = dirtyKey.split("|");
          if (parts.length >= 1) dirtyEventIds.add(parts[0]);
        }
        for (const eventId of dirtyEventIds) {
          if (nearMissCandidates.length >= NEAR_MISS_MAX_PER_PASS) break;
          const families = getFamiliesForEvent(eventId);
          for (const familyId of families) {
            if (nearMissCandidates.length >= NEAR_MISS_MAX_PER_PASS) break;
            // Only scan dirty families
            if (!dirty.has(`${eventId}|${familyId}`)) continue;
            const nms = detectNearMissesForFamily(eventId, familyId, {
              kellyFraction: bettingSettings.kellyFraction,
            });
            for (const nm of nms) {
              if (nearMissCandidates.length >= NEAR_MISS_MAX_PER_PASS) break;
              // Rate limit: skip if we wrote this key recently
              const lastTs = nearMissLastWritten.get(nm.id);
              if (lastTs && now9 - lastTs < NEAR_MISS_COOLDOWN_MS) continue;
              nearMissCandidates.push(nm);
            }
          }
        }

        if (nearMissCandidates.length > 0) {
          // Extract features for near-miss atoms
          const nmWithFeatures: Array<{
            id: string;
            eventId: string;
            familyId: string;
            atomId: string;
            features: number[];
          }> = [];
          for (const nm of nearMissCandidates) {
            try {
              // Build a minimal ValueBet-like object for extractFeatures()
              const nmAsBet = {
                id: nm.id,
                eventId: nm.eventId,
                familyId: nm.familyId,
                atomId: nm.atomId,
                sharpProvider: nm.sharpProvider,
                softProvider: nm.softProvider,
                softOdds: nm.softOdds,
                adjustedSoftOdds: nm.adjustedSoftOdds,
                evPct: nm.evPct,
                trueProb: nm.trueProb,
                trueOdds: 1 / nm.trueProb,
                sharpOdds: 0,
                impliedProb: 1 / nm.adjustedSoftOdds,
                commissionPct: 0,
                edge: nm.evPct / 100,
                kellyFraction: nm.kellyFraction,
                kellyStake: 0,
                detectedAt: nm.detectedAt,
                timestamp: Date.now(),
              };
              const f = extractFeatures(nmAsBet, eventMarketCounts.get(nm.eventId));
              nmWithFeatures.push({
                id: nm.id,
                eventId: nm.eventId,
                familyId: nm.familyId,
                atomId: nm.atomId,
                features: f,
              });
            } catch {
              // Feature extraction failure — skip this near-miss
            }
          }
          if (nmWithFeatures.length > 0) {
            writeNearMissExamples(nmWithFeatures)
              .then((written) => {
                // Update cooldown cache for successfully written near-misses
                for (const nm of nmWithFeatures) {
                  nearMissLastWritten.set(nm.id, now9);
                }
                if (written > 0) {
                  logger.debug(
                    "ReactiveDetector",
                    `Near-miss: ${written} examples written from ${nearMissCandidates.length} candidates`,
                  );
                }
              })
              .catch(() => {}); // fire-and-forget
          }
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

  // Prune the near-miss cooldown cache — remove expired entries
  let prunedNearMiss = 0;
  const nowCleanup = Date.now();
  for (const [key, ts] of nearMissLastWritten.entries()) {
    if (nowCleanup - ts > NEAR_MISS_COOLDOWN_MS) {
      nearMissLastWritten.delete(key);
      prunedNearMiss++;
    }
  }

  const totalPruned =
    prunedOdds + prunedHistory + prunedScores + prunedMultiScores + prunedDedup + prunedNearMiss;
  if (totalPruned > 0) {
    const histStats = getHistoryStats();
    logger.info(
      "ReactiveDetector",
      `Stale cleanup: odds=${prunedOdds} history=${prunedHistory} scores=${prunedScores} multiScores=${prunedMultiScores} dedup=${prunedDedup} nearMiss=${prunedNearMiss} | historyMem≈${(histStats.memoryEstimateBytes / 1024 / 1024).toFixed(1)}MB`,
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
