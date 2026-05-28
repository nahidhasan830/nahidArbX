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
 * ML integration:
 *   - Features are extracted for ALL detected value bets (training data)
 *   - Scoring runs through Vertex AI Prediction (returns null on miss/failure)
 *   - Permission-aware staking via `computeScoredStake()` respects the
 *     deployment gate (shadow/gate_only/stake_reduce/stake_increase)
 *   - Shadow analytics are derived from bets on demand (no separate table)
 *
 * Shadow & near-miss data:
 *   - Shadow-scored detection snapshots stored for every value bet (outcome later)
 *   - Near-miss atoms (0.5% ≤ EV% < MIN_EV_PCT) collected as lower-weight
 *     negative training examples to reduce survival bias
 *   - Rate-limited per bet key (10min cooldown) and capped per pass (5 max)
 *
 * Memory-safe: no accumulation. The dirty set is consumed every pass.
 * Thread-safe: single-threaded JS + mutex flag = no races.
 */

import v8 from "node:v8";

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
  getActiveMarketCountForEvent,
  pruneOddsForStaleEvents,
  getAllOddsForAtom,
  getFamiliesForEvent,
} from "@/lib/atoms/store";
import {
  pruneHistoryForEvents,
  getHistoryStats,
} from "@/lib/atoms/odds-history";
import {
  cleanupOldScores,
  getScoreCount,
  getCornersScoreCount,
} from "@/lib/scores/store";
import {
  cleanupOldMultiScores,
  getMultiScoreCount,
} from "@/lib/scores/multi-source-store";
import { pruneMarketLimitsForStaleEvents } from "@/lib/atoms/market-limits-store";
import { detectAllValueBetsIncremental } from "@/lib/atoms/value-detector";
import { persistValueBets } from "@/lib/db/repositories/bets";
import { recordPredictionBatch } from "@/lib/db/repositories/ml-prediction-audit";
import { getBettingSettings } from "@/lib/db/repositories/betting-settings";
import { maybeAutoPlace } from "@/lib/betting/auto-placer";
import {
  getEvent,
  getMatchedEvents,
  setValueBets,
  getValueBets as storeGetValueBets,
  setSyncStatus,
} from "@/lib/store";
import { invalidateResponseCache } from "@/lib/cache/response-cache";
import { computeDelta } from "@/lib/cache/delta";
import { syncBus } from "@/lib/events/event-bus";
import { buildMovementSnapshot } from "@/lib/atoms/odds-history";
import { extractFeatures, isFeatureWarm } from "@/lib/ml/features";
import {
  FEATURE_COUNT,
  FEATURE_INDEX,
  FEATURE_NAMES_HASH,
  FEATURE_VERSION,
} from "@/lib/ml/feature-contract";
import { scoreBatch, isModelLoaded, getScorerStatus } from "@/lib/ml/scorer";
import {
  computeScoredStake,
  computeKellyMultiplier,
  computeModelEdgePct,
  computeRawStakeMultiplier,
} from "@/lib/ml/staker";
import { classifyDecisionDriver } from "@/lib/ml/decision-reason";
import {
  getPermissionLevel,
  getPolicyEdgeThresholdPct,
} from "@/lib/ml/deployment-gate";
import { isMarketPhaseAllowed } from "@/lib/betting/market-phase";
import { writeDetectionSnapshot } from "@/lib/ml/training-example-writer";
import { getFamily } from "@/lib/atoms/registry";
import { formatAtomLabel } from "@/lib/formatting/labels";

// ============================================
// State — singleton for HMR safety
// ============================================

/** How often to emit heap + store-size telemetry (ms). */
const MEMORY_TELEMETRY_INTERVAL_MS = 60_000; // 1 min

/**
 * Heap-usage fractions that trigger WARN / ERROR log levels.
 * Measured against `v8.getHeapStatistics().heap_size_limit` (the actual
 * V8 ceiling, typically ~1.5GB) rather than `process.memoryUsage().heapTotal`
 * (the *currently allocated* slab, which starts at ~80MB and auto-expands).
 */
const HEAP_WARN_RATIO = 0.7;
const HEAP_ERROR_RATIO = 0.85;

/**
 * Minimum absolute heap usage (MB) before we emit WARN/ERROR.
 * Prevents false alarms during cold-start when the ratio is high but
 * absolute usage is low (e.g. 73/81MB = 90% but well within limits).
 */
const HEAP_MIN_ALARM_MB = 200;

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
  /** True when the next pass should rescore all live value bets. */
  forceFullRescore: false,
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
    while (true) {
      state.needsAnotherPass = false;

      const forceFullRescore = state.forceFullRescore;
      state.forceFullRescore = false;

      const dirty = consumeDirtyFamilies();

      const passStart = Date.now();

      // Operator-controlled market phase gate. Default settings keep the
      // historical pre-match-only behavior; in-play detection must be
      // explicitly enabled from Strategy & limits.
      const nowMs = Date.now();
      const { row: bettingSettings } = await getBettingSettings();
      const eligibleEventIds = getMatchedEvents()
        .filter((e) =>
          isMarketPhaseAllowed(
            e.startTime,
            bettingSettings.valueDetectionPhases,
            nowMs,
          ),
        )
        .map((e) => e.id);

      if (forceFullRescore) {
        for (const eventId of eligibleEventIds) {
          for (const familyId of getFamiliesForEvent(eventId)) {
            dirty.add(`${eventId}|${familyId}`);
          }
        }
      }

      if (dirty.size === 0) break;

      if (eligibleEventIds.length === 0) {
        logger.debug(
          "ReactiveDetector",
          `No value-detection eligible events for phases=${bettingSettings.valueDetectionPhases.join(",")}, skipping pass`,
        );
        break;
      }

      // Run detection
      const valueBets = detectAllValueBetsIncremental(eligibleEventIds, dirty, {
        kellyFraction: bettingSettings.kellyFraction,
      });

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

      const betsToPersist = forceFullRescore ? valueBets : changedBets;

      if (betsToPersist.length > 0) {
        // ── ML feature extraction for ALL live bets ────────────────
        // Extract features for every live value bet, not just changed
        // ones. Time-moving features (tick_velocity, convergence,
        // hours_since_line_opened) would freeze on unchanged bets if
        // we only extracted for dirty bets.
        //
        // Feature extraction failure must never block detection.

        // Build event → active market count from the odds store so
        // num_markets_same_event reflects actual market coverage, not
        // just value-bet detections.
        const eventMarketCounts = new Map<string, number>();
        const seenEvents = new Set<string>();
        for (const vb of valueBets) {
          seenEvents.add(vb.eventId);
        }
        for (const eventId of seenEvents) {
          eventMarketCounts.set(eventId, getActiveMarketCountForEvent(eventId));
        }

        const featuresMap = new Map<string, number[]>();
        const featureStart = Date.now();
        let fqMissingEvent = 0;
        let fqMissingHistory = 0;
        let fqMissingVig = 0;
        let fqCold = 0;
        // Extract for ALL live bets (not just changed)
        for (const vb of valueBets) {
          try {
            const f = extractFeatures(vb, eventMarketCounts.get(vb.eventId));
            featuresMap.set(vb.id, f);
            const tickCount = f[FEATURE_INDEX.tick_count] ?? 0;
            const timeToKickoff = f[FEATURE_INDEX.time_to_kickoff_min] ?? 0;
            const openingSharpOdds = f[FEATURE_INDEX.opening_sharp_odds] ?? 0;
            const vigPct = f[FEATURE_INDEX.vig_pct] ?? 0;
            if (
              timeToKickoff === 0 &&
              tickCount === 0 &&
              openingSharpOdds === 0
            ) {
              fqMissingEvent++;
            }
            if (tickCount === 0 && openingSharpOdds === 0) fqMissingHistory++;
            if (vigPct === 0) fqMissingVig++;
            if (!isFeatureWarm(f)) fqCold++;
          } catch {
            // Feature extraction failure must never block detection
          }
        }
        const featureMs = Date.now() - featureStart;
        if (
          featureMs > 10 ||
          fqMissingEvent > 0 ||
          fqMissingVig > 0 ||
          fqCold > 0
        ) {
          logger.info(
            "ReactiveDetector",
            `Features: ${featuresMap.size}/${valueBets.length} ok, ${featureMs}ms` +
              (fqCold ? ` | cold=${fqCold}` : "") +
              (fqMissingEvent ? ` | missingEvent=${fqMissingEvent}` : "") +
              (fqMissingHistory
                ? ` | missingHistory=${fqMissingHistory}`
                : "") +
              (fqMissingVig ? ` | missingVig=${fqMissingVig}` : ""),
          );
        }

        // ── ML scoring ────────────────────────────────────────────
        // Batch-score all bets with warm features through the cloud-only
        // stub. Without a model, scoreBatch returns null for all
        // (pass-through). Score ALL warm bets — non-positive model-edge
        // bets are still valuable training data. Filtering happens at
        // the auto-placer gate only.
        //
        // Warmup gate: bets with cold features (insufficient
        // odds history) get null ML score. The rule-based value bet
        // row is kept but we don't claim ML confidence.
        const permissionLevel = getPermissionLevel();
        const modelActive = isModelLoaded();
        const scoresMap = new Map<string, number | null>();
        const kellyMap = new Map<string, number | null>();
        const kellyMultiplierMap = new Map<string, number | null>();
        const rawMultiplierMap = new Map<string, number | null>();
        try {
          const featureArrays: number[][] = [];
          const betIds: string[] = [];
          const valueBetById = new Map(valueBets.map((vb) => [vb.id, vb]));
          // Score all warm bets (not just changed — needed for stale
          // score refresh and model-deploy rescore)
          for (const vb of valueBets) {
            const features = featuresMap.get(vb.id);
            if (features && isFeatureWarm(features)) {
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
              const vb = valueBetById.get(betId);
              if (vb) {
                const features = featuresMap.get(betId)!;
                const rawMultiplier =
                  score == null
                    ? null
                    : computeRawStakeMultiplier(score, features);
                rawMultiplierMap.set(betId, rawMultiplier);

                // Compute the multiplier for actual auto-placement stake sizing
                const multiplier = computeKellyMultiplier(
                  score,
                  features,
                  permissionLevel,
                );
                kellyMultiplierMap.set(betId, multiplier);

                // Compute the adjusted Kelly for persistence/display
                const adjusted = computeScoredStake(
                  vb.kellyFraction,
                  score,
                  features,
                  permissionLevel,
                );
                kellyMap.set(betId, adjusted);
              }
            }

            const scorerStatus = getScorerStatus();
            const scoredAt = new Date().toISOString();
            const auditRows = betIds.flatMap((betId) => {
              const vb = valueBetById.get(betId);
              const score = scoresMap.get(betId);
              const features = featuresMap.get(betId);
              const event = vb ? getEvent(vb.eventId) : undefined;
              const family = vb ? getFamily(vb.familyId) : undefined;
              if (
                !vb ||
                score == null ||
                !Number.isFinite(score) ||
                !features ||
                !event ||
                !family
              ) {
                return [];
              }

              const rawMultiplier =
                rawMultiplierMap.get(betId) ??
                computeRawStakeMultiplier(score, features);
              const modelEdgePct = computeModelEdgePct(score, features);
              const decision = classifyDecisionDriver(
                score,
                features,
                rawMultiplier,
              ).decision;

              return [
                {
                  scoredAt,
                  betId,
                  eventId: vb.eventId,
                  familyId: vb.familyId,
                  atomId: vb.atomId,
                  atomLabel: formatAtomLabel(vb.atomId),
                  homeTeam: event.homeTeam,
                  awayTeam: event.awayTeam,
                  competition: event.competition ?? null,
                  eventStartTime: event.startTime.toISOString(),
                  marketType: family.market_type,
                  timeScope: family.time_scope,
                  familyLine: family.line ?? null,
                  softProvider: vb.softProvider,
                  softOdds: vb.softOdds,
                  softCommissionPct: vb.commissionPct,
                  sharpProvider: vb.sharpProvider,
                  sharpOdds: vb.sharpOdds,
                  sharpTrueProb: vb.trueProb,
                  baselineEvPct: vb.evPct,
                  baselineKellyFraction: vb.kellyFraction,
                  modelVersion: scorerStatus.modelVersion,
                  mlScore: score,
                  modelEdgePct,
                  kellyMultiplier: rawMultiplier,
                  mlStakeFraction: kellyMap.get(betId) ?? null,
                  decision,
                  permissionLevel,
                  mlFeatures: features,
                  mlFeatureVersion: FEATURE_VERSION,
                  mlFeatureCount: FEATURE_COUNT,
                  mlFeatureNamesHash: FEATURE_NAMES_HASH,
                },
              ];
            });

            if (auditRows.length > 0) {
              void recordPredictionBatch(auditRows);
            }
          }
        } catch (err) {
          // Scoring failure must never block detection
          logger.warn(
            "ReactiveDetector",
            `ML scoring failed: ${(err as Error).message}`,
          );
        }

        // Log scoring mode on first pass with a model
        if (modelActive && state.totalPasses === 0) {
          const edgeThresholdPct = getPolicyEdgeThresholdPct();
          logger.info(
            "ReactiveDetector",
            `ML scoring active — permission=${permissionLevel}, policyEdgeThreshold=${edgeThresholdPct.toFixed(2)}%, model loaded`,
          );
        }

        try {
          // Enrich persisted bets with movement snapshots from all active providers.
          // Normal passes persist changed bets only; force-rescore passes persist
          // all live bets while auto-placement remains limited to changed bets.
          const enrichedBets = betsToPersist.map((vb) => {
            const allOdds = getAllOddsForAtom(
              vb.eventId,
              vb.familyId,
              vb.atomId,
            );
            const snapshots: Record<
              string,
              import("@/lib/bets-history/types").OddsMovementData
            > = {};

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
              oddsMovement:
                Object.keys(snapshots).length > 0 ? snapshots : undefined,
              mlFeatures: featuresMap.get(vb.id) ?? null,
              mlScore: rawScore ?? null,
              // Only persist ML-adjusted Kelly when permission level actually modifies it
              mlStakeFraction: adjustedKelly ?? null,
            };
          });

          const result = await persistValueBets(enrichedBets);

          // Update the last-persisted cache for successfully written bets
          for (const vb of betsToPersist) {
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

        // Auto-place only changed bets (fire-and-forget per bet). Pass
        // raw ML audit context plus permission separately so the placer
        // cannot bypass the gate by treating "no score" as "no ML".
        for (const vb of changedBets) {
          const rawScore = scoresMap.get(vb.id);
          const kellyMultiplier = kellyMultiplierMap.get(vb.id);

          // Pass the raw ML multiplier to the placer for actual stake sizing.
          // When null/undefined, the placer uses base fullKelly unchanged.
          const multiplierForPlacer =
            kellyMultiplier != null ? kellyMultiplier : undefined;

          maybeAutoPlace(vb, {
            mlScore: rawScore ?? null,
            mlKellyMultiplier: multiplierForPlacer,
            permissionLevel,
          }).catch((err) =>
            logger.error(
              "ReactiveDetector",
              `AutoPlace failed for ${vb.id}: ${(err as Error).message}`,
            ),
          );
        }

        // ── Shadow-scored detection snapshots ────────────────────────
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

        // Near-miss collection removed: simulation showed 524
        // fabricated negative labels inflated the negative training class
        // by 40.1%, distorting the model's learned decision boundary.
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
    logger.debug(
      "ReactiveDetector",
      "Heartbeat: flushing orphan dirty families",
    );
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
 * Emits WARN at 70% and ERROR at 85% of the **V8 heap ceiling**
 * (`heap_size_limit`, typically ~1.5GB) — NOT the transient
 * `heapTotal` allocation, which starts small and auto-expands.
 * A 200MB absolute floor suppresses false alarms on cold start.
 */
function logMemoryTelemetry(): void {
  const mem = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();
  const heapUsedMB = mem.heapUsed / 1024 / 1024;
  const heapLimitMB = heapStats.heap_size_limit / 1024 / 1024;
  const rssMB = mem.rss / 1024 / 1024;
  const externalMB = mem.external / 1024 / 1024;
  const heapRatio = mem.heapUsed / heapStats.heap_size_limit;

  // Gather store cardinalities
  const storeStats = getStoreStats();
  const histStats = getHistoryStats();
  const valueBetCount = storeGetValueBets().length;
  const scoreCount = getScoreCount();
  const cornersCount = getCornersScoreCount();
  const multiScoreCount = getMultiScoreCount();
  const dedupCacheSize = lastPersisted.size;

  const line =
    `heap=${heapUsedMB.toFixed(0)}/${heapLimitMB.toFixed(0)}MB (${(heapRatio * 100).toFixed(0)}%) ` +
    `rss=${rssMB.toFixed(0)}MB ext=${externalMB.toFixed(0)}MB | ` +
    `odds: ${storeStats.totalOddsRecords} atoms, ${storeStats.eventCount} events | ` +
    `history: ${histStats.trackedAtoms} entries ≈${(histStats.memoryEstimateBytes / 1024 / 1024).toFixed(1)}MB | ` +
    `scores: ${scoreCount} live, ${cornersCount} corners, ${multiScoreCount} multi | ` +
    `valueBets=${valueBetCount} dedup=${dedupCacheSize} | ` +
    `passes=${state.totalPasses}`;

  // Only alarm when absolute usage exceeds the floor AND the ratio
  // exceeds the threshold. This prevents CRITICAL on cold starts
  // where heapUsed/heapTotal is high but absolute usage is trivial.
  if (heapUsedMB >= HEAP_MIN_ALARM_MB && heapRatio >= HEAP_ERROR_RATIO) {
    logger.error("MemoryWatch", `CRITICAL: ${line}`);
  } else if (heapUsedMB >= HEAP_MIN_ALARM_MB && heapRatio >= HEAP_WARN_RATIO) {
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

  // Prune market limits store — entries from finished events accumulate forever
  const prunedMarketLimits = pruneMarketLimitsForStaleEvents(activeIds);

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
    prunedOdds + prunedHistory + prunedScores + prunedMultiScores + prunedMarketLimits + prunedDedup;
  if (totalPruned > 0) {
    const histStats = getHistoryStats();
    logger.info(
      "ReactiveDetector",
      `Stale cleanup: odds=${prunedOdds} history=${prunedHistory} scores=${prunedScores} multiScores=${prunedMultiScores} marketLimits=${prunedMarketLimits} dedup=${prunedDedup} | historyMem≈${(histStats.memoryEstimateBytes / 1024 / 1024).toFixed(1)}MB`,
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
  state.cleanupTimer = setInterval(
    runStaleCleanup,
    STALE_ODDS_CLEANUP_INTERVAL_MS,
  );

  // Start memory telemetry watchdog (every 60s)
  state.memoryTimer = setInterval(
    logMemoryTelemetry,
    MEMORY_TELEMETRY_INTERVAL_MS,
  );

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
export function triggerDetection(options?: { forceRescore?: boolean }): void {
  if (!state.running) return;
  if (options?.forceRescore) {
    state.forceFullRescore = true;
  }
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
