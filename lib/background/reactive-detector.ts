
import v8 from "node:v8";

import { singleton } from "@/lib/util/singleton";
import { logger } from "@/lib/shared/logger";
import {
  DETECTION_DEBOUNCE_MS,
  HEARTBEAT_INTERVAL_MS,
  MAX_VALUE_ODDS_AGE_MS,
  STALE_ODDS_CLEANUP_INTERVAL_MS,
} from "@/lib/shared/constants";
import {
  consumeDirtyFamilies,
  hasDirtyFamilies,
  readdDirtyFamilies,
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


const MEMORY_TELEMETRY_INTERVAL_MS = 60_000;

const HEAP_WARN_RATIO = 0.7;
const HEAP_ERROR_RATIO = 0.85;

const HEAP_MIN_ALARM_MB = 200;

const state = singleton("reactive-detector:state", () => ({
  running: false,
  debounceTimer: null as ReturnType<typeof setTimeout> | null,
  heartbeatTimer: null as ReturnType<typeof setInterval> | null,
  cleanupTimer: null as ReturnType<typeof setInterval> | null,
  memoryTimer: null as ReturnType<typeof setInterval> | null,
  passInProgress: false,
  needsAnotherPass: false,
  forceFullRescore: false,
  totalPasses: 0,
  totalDirtyFamilies: 0,
  totalValueBetsFound: 0,
  totalPassDurationMs: 0,
  lastPassAt: null as number | null,
}));

interface PersistedSnapshot {
  sharpOdds: number;
  softOdds: number;
  softProvider: string;
  trueProb: number;
}
const lastPersisted = singleton(
  "reactive-detector:lastPersisted",
  (): Map<string, PersistedSnapshot> => new Map(),
);


async function runDetectionPass(): Promise<void> {
  if (state.passInProgress) {
    state.needsAnotherPass = true;
    return;
  }

  state.passInProgress = true;

  let inFlightDirty: Set<string> | null = null;

  try {
    while (true) {
      state.needsAnotherPass = false;

      const forceFullRescore = state.forceFullRescore;
      state.forceFullRescore = false;

      const dirty = consumeDirtyFamilies();
      inFlightDirty = dirty;

      const passStart = Date.now();

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
        inFlightDirty = null;
        break;
      }

      const valueBets = detectAllValueBetsIncremental(eligibleEventIds, dirty, {
        kellyFraction: bettingSettings.kellyFraction,
      });

      const prevValueCount = storeGetValueBets().length;

      setValueBets(valueBets);
      invalidateResponseCache();

      const changedBets = valueBets.filter((vb) => {
        if (!dirty.has(`${vb.eventId}|${vb.familyId}`)) return false;
        const prev = lastPersisted.get(vb.id);
        if (!prev) return true;
        return (
          prev.sharpOdds !== vb.sharpOdds ||
          prev.softOdds !== vb.softOdds ||
          prev.softProvider !== vb.softProvider ||
          prev.trueProb !== vb.trueProb
        );
      });

      const betsToPersist = forceFullRescore ? valueBets : changedBets;

      if (betsToPersist.length > 0) {

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

        const permissionLevel = getPermissionLevel();
        const modelActive = isModelLoaded();
        const scoresMap = new Map<string, number | null>();
        const kellyMap = new Map<string, number | null>();
        const kellyMultiplierMap = new Map<string, number | null>();
        const rawMultiplierMap = new Map<string, number | null>();
        const scorerStatus = getScorerStatus();
        try {
          const featureArrays: number[][] = [];
          const betIds: string[] = [];
          const valueBetById = new Map(valueBets.map((vb) => [vb.id, vb]));
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

              const vb = valueBetById.get(betId);
              if (vb) {
                const features = featuresMap.get(betId)!;
                const rawMultiplier =
                  score == null
                    ? null
                    : computeRawStakeMultiplier(score, features);
                rawMultiplierMap.set(betId, rawMultiplier);

                const multiplier = computeKellyMultiplier(
                  score,
                  features,
                  permissionLevel,
                );
                kellyMultiplierMap.set(betId, multiplier);

                const adjusted = computeScoredStake(
                  vb.kellyFraction,
                  score,
                  features,
                  permissionLevel,
                );
                kellyMap.set(betId, adjusted);
              }
            }

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
          logger.warn(
            "ReactiveDetector",
            `ML scoring failed: ${(err as Error).message}`,
          );
        }

        if (modelActive && state.totalPasses === 0) {
          const edgeThresholdPct = getPolicyEdgeThresholdPct();
          logger.info(
            "ReactiveDetector",
            `ML scoring active — permission=${permissionLevel}, policyEdgeThreshold=${edgeThresholdPct.toFixed(2)}%, model loaded`,
          );
        }

        try {
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

            const rawScore = scoresMap.get(vb.id);
            const adjustedKelly = kellyMap.get(vb.id);

            return {
              ...vb,
              oddsMovement:
                Object.keys(snapshots).length > 0 ? snapshots : undefined,
              mlFeatures: featuresMap.get(vb.id) ?? null,
              mlScore: rawScore ?? null,
              mlStakeFraction: adjustedKelly ?? null,
            };
          });

          const result = await persistValueBets(enrichedBets);

          const failed = new Set(result.failedIds);
          for (const vb of betsToPersist) {
            if (failed.has(vb.id)) continue;
            lastPersisted.set(vb.id, {
              sharpOdds: vb.sharpOdds,
              softOdds: vb.softOdds,
              softProvider: vb.softProvider,
              trueProb: vb.trueProb,
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

        const changedBetsForPlacement =
          permissionLevel === "observe"
            ? changedBets
            : selectBestMlBetPerFamily(
                changedBets,
                scoresMap,
                kellyMultiplierMap,
                featuresMap,
              );
        for (const vb of changedBetsForPlacement) {
          const rawScore = scoresMap.get(vb.id);
          const kellyMultiplier = kellyMultiplierMap.get(vb.id);

          const multiplierForPlacer =
            kellyMultiplier != null ? kellyMultiplier : undefined;

          maybeAutoPlace(vb, {
            mlScore: rawScore ?? null,
            mlKellyMultiplier: multiplierForPlacer,
            mlModelVersion: scorerStatus.modelVersion,
            mlFeatures: featuresMap.get(vb.id) ?? null,
            mlFeatureVersion: FEATURE_VERSION,
            mlFeatureCount: FEATURE_COUNT,
            mlFeatureNamesHash: FEATURE_NAMES_HASH,
            permissionLevel,
          }).catch((err) =>
            logger.error(
              "ReactiveDetector",
              `AutoPlace failed for ${vb.id}: ${(err as Error).message}`,
            ),
          );
        }

        for (const vb of changedBets) {
          const features = featuresMap.get(vb.id);
          if (features) {
            writeDetectionSnapshot(
              vb.id,
              vb.eventId,
              vb.familyId,
              vb.atomId,
              features,
            ).catch(() => {});
          }
        }

      }

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

      inFlightDirty = null;

      if (!state.needsAnotherPass) break;
    }
  } catch (err) {
    logger.error(
      "ReactiveDetector",
      `Detection pass failed: ${(err as Error).message}`,
    );
    if (inFlightDirty && inFlightDirty.size > 0) {
      readdDirtyFamilies(inFlightDirty);
    }
  } finally {
    state.passInProgress = false;
  }
}


function onDirtySignal(): void {
  if (!state.running) return;

  if (state.debounceTimer !== null) return;

  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null;
    runDetectionPass().catch((err) =>
      logger.error("ReactiveDetector", `Debounced pass error: ${err}`),
    );
  }, DETECTION_DEBOUNCE_MS);
}


function expireStaleValueBets(): boolean {
  const now = Date.now();
  const staleFamilies = new Set<string>();

  for (const vb of storeGetValueBets()) {
    const allOdds = getAllOddsForAtom(vb.eventId, vb.familyId, vb.atomId);
    const sharp = allOdds.get(vb.sharpProvider);
    const soft = allOdds.get(vb.softProvider);

    const sharpStale = !sharp || now - sharp.timestamp > MAX_VALUE_ODDS_AGE_MS;
    const softStale =
      !soft || soft.suspended || now - soft.timestamp > MAX_VALUE_ODDS_AGE_MS;

    if (sharpStale || softStale) {
      staleFamilies.add(`${vb.eventId}|${vb.familyId}`);
    }
  }

  if (staleFamilies.size === 0) return false;

  logger.info(
    "ReactiveDetector",
    `Stale-bet expiry: re-dirtying ${staleFamilies.size} family(ies) with expired odds`,
  );
  readdDirtyFamilies(staleFamilies);
  return true;
}

async function heartbeat(): Promise<void> {
  const expiredAny = expireStaleValueBets();
  if (expiredAny || hasDirtyFamilies()) {
    logger.debug(
      "ReactiveDetector",
      "Heartbeat: flushing orphan/expired dirty families",
    );
    await runDetectionPass();
  }

  try {
    const { captureClosingOdds } = await import("./closing-capture");
    await captureClosingOdds();
  } catch (err) {
    logger.warn(
      "ReactiveDetector",
      `Closing capture failed: ${(err as Error).message}`,
    );
  }

  const stats = getStoreStats();
  setSyncStatus({
    isSyncing: false,
    lastSyncEnd: new Date(),
    currentPhase: "idle",
    phaseProgress: null,
    lastMarketsCount: stats.totalOddsRecords,
  });
}


function logMemoryTelemetry(): void {
  const mem = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();
  const heapUsedMB = mem.heapUsed / 1024 / 1024;
  const heapLimitMB = heapStats.heap_size_limit / 1024 / 1024;
  const rssMB = mem.rss / 1024 / 1024;
  const externalMB = mem.external / 1024 / 1024;
  const heapRatio = mem.heapUsed / heapStats.heap_size_limit;

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

  if (heapUsedMB >= HEAP_MIN_ALARM_MB && heapRatio >= HEAP_ERROR_RATIO) {
    logger.error("MemoryWatch", `CRITICAL: ${line}`);
  } else if (heapUsedMB >= HEAP_MIN_ALARM_MB && heapRatio >= HEAP_WARN_RATIO) {
    logger.warn("MemoryWatch", `HIGH: ${line}`);
  } else {
    logger.info("MemoryWatch", line);
  }
}


function runStaleCleanup(): void {
  const activeEvents = getMatchedEvents();
  const activeIds = new Set(activeEvents.map((e) => e.id));

  const prunedOdds = pruneOddsForStaleEvents(activeIds);

  const prunedHistory = pruneHistoryForEvents(activeIds);

  const prunedScores = cleanupOldScores(3 * 60 * 60 * 1000);
  const prunedMultiScores = cleanupOldMultiScores(3 * 60 * 60 * 1000);

  const prunedMarketLimits = pruneMarketLimitsForStaleEvents(activeIds);

  let prunedDedup = 0;
  const currentBetIds = new Set(storeGetValueBets().map((vb) => vb.id));
  for (const betId of lastPersisted.keys()) {
    if (!currentBetIds.has(betId)) {
      lastPersisted.delete(betId);
      prunedDedup++;
    }
  }

  const totalPruned =
    prunedOdds +
    prunedHistory +
    prunedScores +
    prunedMultiScores +
    prunedMarketLimits +
    prunedDedup;
  if (totalPruned > 0) {
    const histStats = getHistoryStats();
    logger.info(
      "ReactiveDetector",
      `Stale cleanup: odds=${prunedOdds} history=${prunedHistory} scores=${prunedScores} multiScores=${prunedMultiScores} marketLimits=${prunedMarketLimits} dedup=${prunedDedup} | historyMem≈${(histStats.memoryEstimateBytes / 1024 / 1024).toFixed(1)}MB`,
    );
  }
}

function selectBestMlBetPerFamily<
  T extends { id: string; eventId: string; familyId: string; evPct: number },
>(
  valueBets: T[],
  scoresMap: Map<string, number | null>,
  kellyMultiplierMap: Map<string, number | null>,
  featuresMap: Map<string, number[]>,
): T[] {
  const bestByFamily = new Map<string, { bet: T; modelEdgePct: number }>();
  const passthrough: T[] = [];

  for (const vb of valueBets) {
    const multiplier = kellyMultiplierMap.get(vb.id);
    const score = scoresMap.get(vb.id);
    const features = featuresMap.get(vb.id);
    if (
      multiplier == null ||
      multiplier <= 0 ||
      score == null ||
      !Number.isFinite(score) ||
      !features
    ) {
      passthrough.push(vb);
      continue;
    }

    const modelEdgePct = computeModelEdgePct(score, features);
    const key = `${vb.eventId}|${vb.familyId}`;
    const existing = bestByFamily.get(key);
    if (
      !existing ||
      modelEdgePct > existing.modelEdgePct ||
      (modelEdgePct === existing.modelEdgePct &&
        vb.evPct > existing.bet.evPct) ||
      (modelEdgePct === existing.modelEdgePct &&
        vb.evPct === existing.bet.evPct &&
        vb.id < existing.bet.id)
    ) {
      bestByFamily.set(key, { bet: vb, modelEdgePct });
    }
  }

  return [
    ...passthrough,
    ...Array.from(bestByFamily.values(), (entry) => entry.bet),
  ];
}


export function startReactiveDetector(): void {
  if (state.running) {
    logger.debug("ReactiveDetector", "Already running");
    return;
  }

  state.running = true;

  setOnDirtyCallback(onDirtySignal);

  state.heartbeatTimer = setInterval(() => {
    heartbeat().catch((err) =>
      logger.error("ReactiveDetector", `Heartbeat error: ${err}`),
    );
  }, HEARTBEAT_INTERVAL_MS);

  state.cleanupTimer = setInterval(
    runStaleCleanup,
    STALE_ODDS_CLEANUP_INTERVAL_MS,
  );

  state.memoryTimer = setInterval(
    logMemoryTelemetry,
    MEMORY_TELEMETRY_INTERVAL_MS,
  );

  logMemoryTelemetry();

  logger.info(
    "ReactiveDetector",
    `Started (debounce=${DETECTION_DEBOUNCE_MS}ms, heartbeat=${HEARTBEAT_INTERVAL_MS / 1000}s, cleanup=${STALE_ODDS_CLEANUP_INTERVAL_MS / 60_000}min, memWatch=${MEMORY_TELEMETRY_INTERVAL_MS / 1000}s)`,
  );
}

export function stopReactiveDetector(): void {
  state.running = false;

  setOnDirtyCallback(null);

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

export function triggerDetection(options?: { forceRescore?: boolean }): void {
  if (!state.running) return;
  if (options?.forceRescore) {
    state.forceFullRescore = true;
  }
  runDetectionPass().catch((err) =>
    logger.error("ReactiveDetector", `Manual trigger error: ${err}`),
  );
}

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
