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
 * After PILOT_MIN_SETTLED bets settle, run the Opdyke two-sample test between
 * the boosted and unboosted cohorts. If boosted beats unboosted with PSR ≥ 0.95,
 * unlock `stake_increase` for the deployed model.
 *
 * This is a completely honest experiment — the coin flip guarantees no
 * selection bias. The only difference between groups is random chance.
 */

import { singleton } from "../util/singleton";
import { logger } from "../shared/logger";

const PILOT_MIN_SETTLED = 50;
const PILOT_MIN_PER_GROUP = 15;

interface PilotState {
  active: boolean;
  modelVersion: number | null;
  startedAt: number;
  boostCount: number;
  controlCount: number;
  settledBoostCount: number;
  settledControlCount: number;
}

const pilot = singleton<Map<string, { boosted: boolean; settled: boolean; unitReturn: number | null }>>(
  "ml:pilot-bets",
  () => new Map(),
);

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
  logger.info("MLPilot", `Stake-increase pilot started for model v${modelVersion}. Target: ${PILOT_MIN_SETTLED} settled bets.`);
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
  if (!pilotMeta.active) {
    return { ready: false, shouldPromote: false, psr: 0, boostMean: 0, controlMean: 0, boostN: 0, controlN: 0 };
  }

  const totalSettled = pilotMeta.settledBoostCount + pilotMeta.settledControlCount;
  if (totalSettled < PILOT_MIN_SETTLED) {
    return { ready: false, shouldPromote: false, psr: 0, boostMean: 0, controlMean: 0, boostN: 0, controlN: 0 };
  }

  if (pilotMeta.settledBoostCount < PILOT_MIN_PER_GROUP || pilotMeta.settledControlCount < PILOT_MIN_PER_GROUP) {
    logger.info("MLPilot", `Insufficient per-group samples: boost=${pilotMeta.settledBoostCount}, control=${pilotMeta.settledControlCount}`);
    return { ready: false, shouldPromote: false, psr: 0, boostMean: 0, controlMean: 0, boostN: 0, controlN: 0 };
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

  if (boostReturns.length < PILOT_MIN_PER_GROUP || controlReturns.length < PILOT_MIN_PER_GROUP) {
    return { ready: false, shouldPromote: false, psr: 0, boostMean: 0, controlMean: 0, boostN: 0, controlN: 0 };
  }

  const boostMean = boostReturns.reduce((a, b) => a + b, 0) / boostReturns.length;
  const controlMean = controlReturns.reduce((a, b) => a + b, 0) / controlReturns.length;

  const { evaluatePromotion } = await import("./promotion");
  const decision = evaluatePromotion(
    { version: 0, unitReturns: controlReturns, sampleSize: controlReturns.length },
    { version: 1, unitReturns: boostReturns, sampleSize: boostReturns.length },
  );

  return {
    ready: true,
    shouldPromote: decision.promote,
    psr: decision.psr,
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
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

// ── A/B test framework (champion vs challenger on placed bets) ───────

const AB_MIN_SETTLED = 40;
const AB_MIN_PER_GROUP = 10;

interface ABTestState {
  active: boolean;
  championVersion: number | null;
  challengerVersion: number | null;
  startedAt: number;
  championCount: number;
  challengerCount: number;
  settledChampionCount: number;
  settledChallengerCount: number;
}

const abBets = singleton<Map<string, { useChallenger: boolean; settled: boolean; unitReturn: number | null }>>(
  "ml:ab-bets",
  () => new Map(),
);

const abMeta = singleton<ABTestState>("ml:ab-meta", () => ({
  active: false,
  championVersion: null,
  challengerVersion: null,
  startedAt: 0,
  championCount: 0,
  challengerCount: 0,
  settledChampionCount: 0,
  settledChallengerCount: 0,
}));

/**
 * Start an A/B test between champion and challenger.
 * Placed bets will be randomly routed to one of the two models.
 */
export function startABTest(championVersion: number, challengerVersion: number): void {
  abMeta.active = true;
  abMeta.championVersion = championVersion;
  abMeta.challengerVersion = challengerVersion;
  abMeta.startedAt = Date.now();
  abMeta.championCount = 0;
  abMeta.challengerCount = 0;
  abMeta.settledChampionCount = 0;
  abMeta.settledChallengerCount = 0;
  abBets.clear();
  logger.info(
    "MLABTest",
    `A/B test started: champion v${championVersion} vs challenger v${challengerVersion}. Target: ${AB_MIN_SETTLED} settled bets.`,
  );
}

export function stopABTest(): void {
  abMeta.active = false;
  abMeta.championVersion = null;
  abMeta.challengerVersion = null;
  abBets.clear();
}

export function isABTestActive(): boolean {
  return abMeta.active;
}

/**
 * For a placed bet, decide whether to use challenger scores.
 * 50/50 random routing based on betId hash.
 *
 * @returns true if challenger should be used, false for champion.
 */
export function abTestRoute(betId: string): boolean {
  if (!abMeta.active) return false;
  const useChallenger = simpleHash(betId + "ab") % 2 === 0;
  abBets.set(betId, { useChallenger, settled: false, unitReturn: null });
  if (useChallenger) {
    abMeta.challengerCount++;
  } else {
    abMeta.championCount++;
  }
  return useChallenger;
}

export function settleABBet(betId: string, unitReturn: number): void {
  const entry = abBets.get(betId);
  if (!entry) return;
  entry.settled = true;
  entry.unitReturn = unitReturn;
  if (entry.useChallenger) {
    abMeta.settledChallengerCount++;
  } else {
    abMeta.settledChampionCount++;
  }
}

export async function evaluateABTest(): Promise<{
  ready: boolean;
  promoteChallenger: boolean;
  psr: number;
  championMean: number;
  challengerMean: number;
  championN: number;
  challengerN: number;
}> {
  if (!abMeta.active) {
    return { ready: false, promoteChallenger: false, psr: 0, championMean: 0, challengerMean: 0, championN: 0, challengerN: 0 };
  }

  const totalSettled = abMeta.settledChampionCount + abMeta.settledChallengerCount;
  if (totalSettled < AB_MIN_SETTLED) {
    return { ready: false, promoteChallenger: false, psr: 0, championMean: 0, challengerMean: 0, championN: 0, challengerN: 0 };
  }

  if (abMeta.settledChampionCount < AB_MIN_PER_GROUP || abMeta.settledChallengerCount < AB_MIN_PER_GROUP) {
    return { ready: false, promoteChallenger: false, psr: 0, championMean: 0, challengerMean: 0, championN: 0, challengerN: 0 };
  }

  const championReturns: number[] = [];
  const challengerReturns: number[] = [];
  for (const entry of abBets.values()) {
    if (!entry.settled || entry.unitReturn == null) continue;
    if (entry.useChallenger) {
      challengerReturns.push(entry.unitReturn);
    } else {
      championReturns.push(entry.unitReturn);
    }
  }

  const championMean = championReturns.reduce((a, b) => a + b, 0) / championReturns.length;
  const challengerMean = challengerReturns.reduce((a, b) => a + b, 0) / challengerReturns.length;

  const { evaluatePromotion } = await import("./promotion");
  const decision = evaluatePromotion(
    { version: abMeta.championVersion ?? 0, unitReturns: championReturns, sampleSize: championReturns.length },
    { version: abMeta.challengerVersion ?? 0, unitReturns: challengerReturns, sampleSize: challengerReturns.length },
  );

  return {
    ready: true,
    promoteChallenger: decision.promote,
    psr: decision.psr,
    championMean,
    challengerMean,
    championN: championReturns.length,
    challengerN: challengerReturns.length,
  };
}

export function getABTestStatus() {
  return {
    active: abMeta.active,
    championVersion: abMeta.championVersion,
    challengerVersion: abMeta.challengerVersion,
    startedAt: abMeta.startedAt,
    championCount: abMeta.championCount,
    challengerCount: abMeta.challengerCount,
    settledChampionCount: abMeta.settledChampionCount,
    settledChallengerCount: abMeta.settledChallengerCount,
    targetSettled: AB_MIN_SETTLED,
  };
}
