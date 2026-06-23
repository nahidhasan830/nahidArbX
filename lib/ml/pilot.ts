
import { singleton } from "../util/singleton";
import { logger } from "../shared/logger";

const PILOT_MIN_SETTLED = 50;
const PILOT_MIN_PER_GROUP = 15;
const PILOT_PSR_THRESHOLD = 0.95;
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

export function stopPilot(): void {
  pilotMeta.active = false;
  pilotMeta.modelVersion = null;
  pilot.clear();
  logger.info("MLPilot", "Pilot stopped.");
}

export function isPilotActive(): boolean {
  return pilotMeta.active;
}

export function pilotCoinFlip(betId: string): boolean {
  if (!pilotMeta.active) return false;

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
