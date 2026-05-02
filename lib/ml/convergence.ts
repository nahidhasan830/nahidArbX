/**
 * Convergence Calculator
 *
 * Measures how quickly soft bookmaker odds are converging toward
 * (or diverging from) sharp bookmaker odds. Used as ML feature #14.
 *
 * Algorithm:
 * 1. Take last N ticks from each provider
 * 2. Interpolate sharp odds at each soft tick timestamp
 * 3. Compute gap series: softOdds - interpolatedSharpOdds
 * 4. OLS linear regression on (time, gap) → slope
 * 5. Negative slope = converging (value window closing)
 *    Positive slope = diverging (edge growing)
 */

import { getOrderedTicks, type OddsTick } from "@/lib/atoms/odds-history";

/**
 * Compute the rate at which soft odds are converging toward sharp odds.
 *
 * @returns Negative = converging (soft approaching sharp),
 *          Positive = diverging (edge growing),
 *          0 = insufficient data
 */
export function computeConvergenceRate(
  eventId: string,
  familyId: string,
  atomId: string,
  sharpProvider: string,
  softProvider: string,
  windowTicks = 20,
): number {
  const sharpTicks = getOrderedTicks(eventId, familyId, atomId, sharpProvider);
  const softTicks = getOrderedTicks(eventId, familyId, atomId, softProvider);

  if (sharpTicks.length < 2 || softTicks.length < 2) return 0;

  // Take last `windowTicks` from each
  const sharpWindow = sharpTicks.slice(-windowTicks);
  const softWindow = softTicks.slice(-windowTicks);

  // For each soft tick, interpolate the sharp odds at that timestamp
  const alignedPairs: { timestamp: number; gap: number }[] = [];

  for (const softTick of softWindow) {
    if (softTick.suspended) continue;

    const interpolated = interpolateSharpOdds(sharpWindow, softTick.timestamp);
    if (interpolated === null) continue;

    alignedPairs.push({
      timestamp: softTick.timestamp,
      gap: softTick.odds - interpolated,
    });
  }

  // Need at least 3 aligned pairs for meaningful regression
  if (alignedPairs.length < 3) return 0;

  // Normalize timestamps: x = (tick.timestamp - firstTick.timestamp) / 1000
  const t0 = alignedPairs[0].timestamp;
  const xs = alignedPairs.map((p) => (p.timestamp - t0) / 1000);
  const ys = alignedPairs.map((p) => p.gap);

  // OLS linear regression: slope = Σ((x-x̄)(y-ȳ)) / Σ((x-x̄)²)
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

/**
 * Interpolate sharp odds at a given timestamp using surrounding ticks.
 *
 * - If both surrounding ticks exist: linear interpolation
 * - If only `before` exists and age < 5s: flat extrapolation
 * - Otherwise: null (no aligned pair)
 */
function interpolateSharpOdds(
  sharpTicks: OddsTick[],
  targetTs: number,
): number | null {
  // Find surrounding sharp ticks [before, after]
  let before: OddsTick | null = null;
  let after: OddsTick | null = null;

  for (let i = 0; i < sharpTicks.length; i++) {
    const tick = sharpTicks[i];
    if (tick.suspended) continue;

    if (tick.timestamp <= targetTs) {
      before = tick;
    } else {
      after = tick;
      break;
    }
  }

  if (before && after) {
    // Linear interpolation
    const range = after.timestamp - before.timestamp;
    if (range === 0) return before.odds;
    const t = (targetTs - before.timestamp) / range;
    return before.odds + (after.odds - before.odds) * t;
  }

  if (before) {
    // Flat extrapolation if age < 5 seconds
    const ageMs = targetTs - before.timestamp;
    if (ageMs < 5000) return before.odds;
  }

  return null;
}
