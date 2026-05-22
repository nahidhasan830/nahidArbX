/**
 * Stake-increase pilot — controlled experiment for promotion to stake_increase.
 *
 * When the model is at `stake_reduce` with good metrics, it cannot increase
 * stakes (capped at ×1.0). The pilot runs a coin-flip experiment:
 *
 *   - On every bet where the model wants to boost (×>1.05), flip a fair coin.
 *   - Heads: use the boosted Kelly (as if stake_increase were active).
 *   - Tails: use ×1.0 (current stake_reduce cap).
 *
 * After PILOT_MIN_SETTLED bets settle, run the Opdyke two-sample Sharpe test
 * between the boosted and unboosted cohorts. If the boosted cohort beats the
 * unboosted cohort with PSR ≥ 0.95 and a meaningful ROI improvement, unlock
 * `stake_increase` for the deployed model.
 *
 * This is a completely honest experiment — the coin flip guarantees no
 * selection bias. The only difference between groups is random chance.
 */

import { singleton } from "../util/singleton";
import { logger } from "../shared/logger";

const PILOT_MIN_SETTLED = 50;
const PILOT_MIN_PER_GROUP = 15;
/** PSR threshold to unlock stake_increase. */
const PILOT_PSR_THRESHOLD = 0.95;
/** Minimum boosted-vs-control ROI improvement (percentage points). */
const PILOT_MIN_ROI_IMPROVEMENT_PCT = 0.5;

interface PilotState {
  active: boolean;
  modelVersion: number | null;
  startedAt: number;
  boostCount: number;
  controlCount: number;
  settledBoostCount: number;
  settledControlCount: number;
}

const pilot = singleton<
  Map<string, { boosted: boolean; settled: boolean; unitReturn: number | null }>
>("ml:pilot-bets", () => new Map());

const pilotMeta = singleton<PilotState>("ml:pilot-meta", () => ({
  active: false,
  modelVersion: null,
  startedAt: 0,
  boostCount: 0,
  controlCount: 0,
  settledBoostCount: 0,
  settledControlCount: 0,
}));

/**
 * Start a pilot experiment for the current model version.
 */
export function startPilot(modelVersion: number): void {
  pilotMeta.active = true;
  pilotMeta.modelVersion = modelVersion;
  pilotMeta.startedAt = Date.now();
  pilotMeta.boostCount = 0;
  pilotMeta.controlCount = 0;
  pilotMeta.settledBoostCount = 0;
  pilotMeta.settledControlCount = 0;
  pilot.clear();
  logger.info(
    "MLPilot",
    `Stake-increase pilot started for model v${modelVersion}. Target: ${PILOT_MIN_SETTLED} settled bets.`,
  );
}

/**
 * Stop the pilot experiment.
 */
export function stopPilot(): void {
  pilotMeta.active = false;
  pilotMeta.modelVersion = null;
  pilot.clear();
  logger.info("MLPilot", "Pilot stopped.");
}

/**
 * Whether a pilot is currently running.
 */
export function isPilotActive(): boolean {
  return pilotMeta.active;
}

/**
 * For a bet that the model wants to boost (raw multiplier > 1.05):
 * flip a coin to decide whether to actually apply the boost.
 *
 * @param betId - unique identifier for the bet
 * @returns true if boost should be applied, false if it should be held at ×1.0
 */
export function pilotCoinFlip(betId: string): boolean {
  if (!pilotMeta.active) return false;

  // Deterministic coin flip based on betId hash (reproducible, no RNG state needed)
  const hash = simpleHash(betId);
  const boosted = hash % 2 === 0;

  pilot.set(betId, { boosted, settled: false, unitReturn: null });
  if (boosted) {
    pilotMeta.boostCount++;
  } else {
    pilotMeta.controlCount++;
  }

  return boosted;
}

/**
 * Mark a pilot bet as settled with its unit return.
 */
export function settlePilotBet(betId: string, unitReturn: number): void {
  const entry = pilot.get(betId);
  if (!entry) return;
  entry.settled = true;
  entry.unitReturn = unitReturn;
  if (entry.boosted) {
    pilotMeta.settledBoostCount++;
  } else {
    pilotMeta.settledControlCount++;
  }
}

/**
 * Evaluate the pilot results and determine whether to promote to stake_increase.
 */
export async function evaluatePilot(): Promise<{
  ready: boolean;
  shouldPromote: boolean;
  psr: number;
  boostMean: number;
  controlMean: number;
  boostN: number;
  controlN: number;
}> {
  const empty = {
    ready: false,
    shouldPromote: false,
    psr: 0,
    boostMean: 0,
    controlMean: 0,
    boostN: 0,
    controlN: 0,
  };

  if (!pilotMeta.active) return empty;

  const totalSettled =
    pilotMeta.settledBoostCount + pilotMeta.settledControlCount;
  if (totalSettled < PILOT_MIN_SETTLED) return empty;

  if (
    pilotMeta.settledBoostCount < PILOT_MIN_PER_GROUP ||
    pilotMeta.settledControlCount < PILOT_MIN_PER_GROUP
  ) {
    logger.info(
      "MLPilot",
      `Insufficient per-group samples: boost=${pilotMeta.settledBoostCount}, control=${pilotMeta.settledControlCount}`,
    );
    return empty;
  }

  const boostReturns: number[] = [];
  const controlReturns: number[] = [];
  for (const entry of pilot.values()) {
    if (!entry.settled || entry.unitReturn == null) continue;
    if (entry.boosted) {
      boostReturns.push(entry.unitReturn);
    } else {
      controlReturns.push(entry.unitReturn);
    }
  }

  if (
    boostReturns.length < PILOT_MIN_PER_GROUP ||
    controlReturns.length < PILOT_MIN_PER_GROUP
  ) {
    return empty;
  }

  const boostMean =
    boostReturns.reduce((a, b) => a + b, 0) / boostReturns.length;
  const controlMean =
    controlReturns.reduce((a, b) => a + b, 0) / controlReturns.length;

  // Two-sample Sharpe comparison (Opdyke PSR).
  const { compareGroupSharpes } = await import("./sharpe-ab-test");
  const result = compareGroupSharpes(
    {
      label: "control",
      unitReturns: controlReturns,
      sampleSize: controlReturns.length,
    },
    {
      label: "boost",
      unitReturns: boostReturns,
      sampleSize: boostReturns.length,
    },
  );

  // Pilot promotion gates: boost must beat control by enough margin AND PSR.
  const roiImprovementPct = (boostMean - controlMean) * 100;
  const shouldPromote =
    result.psr >= PILOT_PSR_THRESHOLD &&
    roiImprovementPct >= PILOT_MIN_ROI_IMPROVEMENT_PCT;

  return {
    ready: true,
    shouldPromote,
    psr: result.psr,
    boostMean,
    controlMean,
    boostN: boostReturns.length,
    controlN: controlReturns.length,
  };
}

/**
 * Get pilot status for diagnostics.
 */
export function getPilotStatus() {
  return {
    active: pilotMeta.active,
    modelVersion: pilotMeta.modelVersion,
    startedAt: pilotMeta.startedAt,
    boostCount: pilotMeta.boostCount,
    controlCount: pilotMeta.controlCount,
    settledBoostCount: pilotMeta.settledBoostCount,
    settledControlCount: pilotMeta.settledControlCount,
    totalBets: pilot.size,
    targetSettled: PILOT_MIN_SETTLED,
  };
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash);
}
