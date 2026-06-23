
import { getOrderedTicks } from "@/lib/atoms/odds-history";

export interface ConvergenceTick {
  odds: number;
  timestamp: number;
}

export function computeConvergenceRate(
  eventId: string,
  familyId: string,
  atomId: string,
  sharpProvider: string,
  softProvider: string,
  windowTicks = 20,
): number {
  const sharpTicks = getOrderedTicks(eventId, familyId, atomId, sharpProvider)
    .filter((tick) => !tick.suspended)
    .map((tick) => ({ odds: tick.odds, timestamp: tick.timestamp }));
  const softTicks = getOrderedTicks(eventId, familyId, atomId, softProvider)
    .filter((tick) => !tick.suspended)
    .map((tick) => ({ odds: tick.odds, timestamp: tick.timestamp }));

  return computeConvergenceRateFromTicks(sharpTicks, softTicks, windowTicks);
}

export function computeConvergenceRateFromTicks(
  sharpTicks: ConvergenceTick[],
  softTicks: ConvergenceTick[],
  windowTicks = 20,
): number {
  if (sharpTicks.length < 2 || softTicks.length < 2) return 0;

  const sharpWindow = sharpTicks.slice(-windowTicks);
  const softWindow = softTicks.slice(-windowTicks);
  const alignedPairs: { timestamp: number; gap: number }[] = [];

  for (const softTick of softWindow) {
    const interpolated = interpolateSharpOdds(sharpWindow, softTick.timestamp);
    if (interpolated === null) continue;

    alignedPairs.push({
      timestamp: softTick.timestamp,
      gap: softTick.odds - interpolated,
    });
  }

  if (alignedPairs.length < 3) return 0;

  const t0 = alignedPairs[0].timestamp;
  const xs = alignedPairs.map((p) => (p.timestamp - t0) / 1000);
  const ys = alignedPairs.map((p) => p.gap);

  const n = xs.length;
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xMean;
    numerator += dx * (ys[i] - yMean);
    denominator += dx * dx;
  }

  if (denominator === 0) return 0;

  return Math.round((numerator / denominator) * 10000) / 10000;
}

function interpolateSharpOdds(
  sharpTicks: ConvergenceTick[],
  targetTs: number,
): number | null {
  let before: ConvergenceTick | null = null;
  let after: ConvergenceTick | null = null;

  for (let i = 0; i < sharpTicks.length; i++) {
    const tick = sharpTicks[i];

    if (tick.timestamp <= targetTs) {
      before = tick;
    } else {
      after = tick;
      break;
    }
  }

  if (before && after) {
    const range = after.timestamp - before.timestamp;
    if (range === 0) return before.odds;
    const t = (targetTs - before.timestamp) / range;
    return before.odds + (after.odds - before.odds) * t;
  }

  if (before) {
    const ageMs = targetTs - before.timestamp;
    if (ageMs < 5000) return before.odds;
  }

  return null;
}
