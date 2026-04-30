/**
 * Vig Removal - True Probability Calculation (Full Worst-Case Composite)
 *
 * Removes the bookmaker margin (vig) from odds to get true probabilities.
 * Uses the "Worst-Case" composite: runs ALL FOUR standard devig methods,
 * then picks the HIGHEST true probability per atom (= lowest true odds =
 * most conservative EV estimate).
 *
 * Why worst-case?  We don't know exactly how Pinnacle structures its
 * margin.  By taking the most pessimistic fair probability for each
 * outcome, we ensure that any bet flagged as +EV genuinely has edge
 * regardless of which devig model is "correct".  This eliminates
 * false-positive value signals at the cost of slightly fewer triggers.
 *
 * The four methods and when each is most accurate:
 *
 * 1. Multiplicative: trueProb = rawProb / Σ(rawProb)
 *    Simple proportional scaling.  Accurate for balanced markets.
 *    Ignores the favorite-longshot bias (FLB).
 *
 * 2. Additive: trueProb = rawProb − (Σ(rawProb) − 1) / n
 *    Equal margin subtraction.  Corrects for FLB in balanced 2-way
 *    markets.  Can produce infeasible (≤0) probabilities on extreme
 *    longshots — we clamp those to a floor.
 *
 * 3. Power: find k s.t. Σ(rawProb^k) = 1, then trueProb = rawProb^k
 *    Non-linear vig distribution.  Robust FLB correction that always
 *    produces valid probabilities.  Best for lopsided lines.
 *
 * 4. Shin: solve for insider fraction z in
 *      trueProb = (√(z² + 4(1−z) · rawProb · S) − z) / (2(1−z))
 *    where S = Σ(rawProb).  Based on Hyun Song Shin's 1991/1993
 *    academic model of bookmaker pricing with informed bettors.
 *    Most theoretically grounded for 3+ outcome markets (soccer 1X2).
 *    For 2-way markets, equivalent to Additive.
 *
 * For balanced markets all four methods converge, so the composite adds
 * no penalty.  The divergence only matters on lopsided moneylines and
 * 3-way markets where false +EV is most likely.
 */

import type { ProviderKey } from "../providers/registry";
import { getAllOddsForAtom } from "./store";
import { getFamily } from "./registry";

// ============================================
// Types
// ============================================

export interface TrueOddsResult {
  atomId: string;
  rawOdds: number; // Original odds from bookmaker
  rawProb: number; // Implied probability (1/odds) before vig removal
  trueProb: number; // After vig removal (worst-case across methods)
  trueOdds: number; // 1 / trueProb
  vigPct: number; // Vig % applied to this outcome
  /** Which devig method produced the worst-case (highest) trueProb */
  worstCaseMethod: DevigMethod;
}

export type DevigMethod = "multiplicative" | "additive" | "power" | "shin";

export interface FamilyTrueOdds {
  familyId: string;
  provider: ProviderKey;
  totalImpliedProb: number; // Sum of 1/odds (includes vig, e.g., 1.056)
  vigPct: number; // Total family vig (e.g., 5.6%)
  atoms: TrueOddsResult[];
}

// ============================================
// Power Method Solver
// ============================================

/**
 * Find exponent k such that Σ(p_i^k) = 1 via binary search.
 *
 * When raw implied probs sum to > 1 (overround), k > 1 shrinks them.
 * Convergence is guaranteed because f(k) = Σ(p_i^k) is strictly
 * decreasing for p_i ∈ (0,1) and f(1) > 1 (overround exists).
 *
 * 50 iterations give ~15 decimal digits of precision — far more
 * than IEEE 754 doubles need.
 */
function solvePowerExponent(rawProbs: number[]): number {
  let lo = 1; // k=1 → sum = overround > 1
  let hi = 100; // large k → sum ≈ 0

  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    let sum = 0;
    for (const p of rawProbs) sum += Math.pow(p, mid);
    if (sum > 1) lo = mid;
    else hi = mid;
  }

  return (lo + hi) / 2;
}

// ============================================
// Shin Method Solver
// ============================================

/**
 * Solve for the Shin insider fraction z.
 *
 * Shin's model (1991, 1993) assumes a fraction z of bettors are
 * "insiders" with perfect information.  The bookmaker sets odds to
 * maximize profit given this mix.  The fair probability for outcome i is:
 *
 *   trueProb_i = (√(z² + 4(1−z) · p_i² / S) − z) / (2(1−z))
 *
 * where p_i = 1/odds_i and S = Σ(p_i).
 *
 * For n > 2 outcomes, z is found via fixed-point iteration:
 *   z_new = (Σ √(z² + 4(1-z) · p_i² / S) − 2) / (n − 2)
 *
 * For n = 2 outcomes, z has an analytical solution (equivalent to
 * the Additive method).
 *
 * z ∈ (0, 1) — typically very small (0.01–0.05 for Pinnacle).
 *
 * Reference: mberk/shin (Python/Rust implementation of Shin 1991, 1993)
 */
function solveShinZ(rawProbs: number[], totalImplied: number): number {
  const n = rawProbs.length;

  // 2-outcome analytical formula (equivalent to Additive)
  if (n === 2) {
    const diff = rawProbs[0] - rawProbs[1];
    const S = totalImplied;
    return ((S - 1) * (diff * diff - S)) / (S * (diff * diff - 1));
  }

  // n > 2: fixed-point iteration (converges in ~20–50 iterations)
  let z = 0;
  for (let iter = 0; iter < 1000; iter++) {
    let sumSqrt = 0;
    for (const p of rawProbs) {
      sumSqrt += Math.sqrt(z * z + (4 * (1 - z) * p * p) / totalImplied);
    }
    const zNew = (sumSqrt - 2) / (n - 2);
    if (Math.abs(zNew - z) < 1e-12) break;
    z = zNew;
  }

  return z;
}

/**
 * Compute Shin true probabilities given solved z.
 *
 * trueProb_i = (√(z² + 4(1−z) · p_i² / S) − z) / (2(1−z))
 */
function computeShinProbs(
  rawProbs: number[],
  totalImplied: number,
  z: number,
): number[] {
  const denom = 2 * (1 - z);
  return rawProbs.map(
    (p) =>
      (Math.sqrt(z * z + (4 * (1 - z) * p * p) / totalImplied) - z) / denom,
  );
}

// ============================================
// Additive Method
// ============================================

/** Minimum floor for additive probabilities to avoid infeasible values */
const ADDITIVE_FLOOR = 0.001; // 0.1%

/**
 * Compute additive (equal margin) true probabilities.
 *
 * trueProb_i = rawProb_i − margin / n
 *
 * where margin = Σ(rawProb) − 1 and n = number of outcomes.
 * Clamped to ADDITIVE_FLOOR to avoid negative/zero probabilities
 * on extreme longshots.
 */
function computeAdditiveProbs(
  rawProbs: number[],
  totalImplied: number,
): number[] {
  const n = rawProbs.length;
  const marginPerOutcome = (totalImplied - 1) / n;
  return rawProbs.map((p) => Math.max(p - marginPerOutcome, ADDITIVE_FLOOR));
}

// ============================================
// Vig Removal Functions
// ============================================

/**
 * Calculate true odds for a family from a specific provider.
 *
 * Full Worst-Case composite: for each atom, computes true probability via
 * all four methods (Multiplicative, Additive, Power, Shin), then selects
 * the HIGHEST trueProb (= lowest trueOdds = most conservative for the bettor).
 *
 * @param eventId - Normalized event ID
 * @param familyId - Family ID (e.g., "ft_match_result")
 * @param provider - Provider to get odds from (typically "pinnacle")
 * @returns True odds for all atoms, or null if incomplete/suspended
 */
export function calculateTrueOddsForFamily(
  eventId: string,
  familyId: string,
  provider: ProviderKey,
): FamilyTrueOdds | null {
  const family = getFamily(familyId);
  if (!family) return null;

  const rawOdds: { atomId: string; odds: number }[] = [];
  let totalImpliedProb = 0;

  // Collect all raw odds for the family
  for (const atomId of family.atoms) {
    const oddsMap = getAllOddsForAtom(eventId, familyId, atomId);
    const providerOdds = oddsMap.get(provider);

    if (!providerOdds || providerOdds.suspended) {
      // Missing or suspended odds - can't calculate true odds
      return null;
    }

    // Validate odds (must be > 1)
    if (providerOdds.odds <= 1) {
      return null;
    }

    rawOdds.push({ atomId, odds: providerOdds.odds });
    totalImpliedProb += 1 / providerOdds.odds;
  }

  // Ensure we have odds for all atoms
  if (rawOdds.length !== family.atoms.length) {
    return null;
  }

  // Family vig = (sum of implied probs - 1) * 100
  const vigPct = (totalImpliedProb - 1) * 100;
  const rawProbs = rawOdds.map(({ odds }) => 1 / odds);

  // --- Method 1: Multiplicative (proportional) ---
  // trueProb = rawProb / Σ(rawProb)
  const multProbs = rawProbs.map((p) => p / totalImpliedProb);

  // --- Method 2: Additive (equal margin) ---
  // trueProb = rawProb − (Σ(rawProb) − 1) / n
  const addProbs = computeAdditiveProbs(rawProbs, totalImpliedProb);

  // --- Method 3: Power ---
  // find k s.t. Σ(rawProb^k) = 1, then trueProb = rawProb^k
  const k = solvePowerExponent(rawProbs);
  const powerProbs = rawProbs.map((p) => Math.pow(p, k));

  // --- Method 4: Shin ---
  // solve for z s.t. Σ shinProb(p_i, z) = 1
  const z = solveShinZ(rawProbs, totalImpliedProb);
  const shinProbs = computeShinProbs(rawProbs, totalImpliedProb, z);

  // --- Worst-Case: pick highest trueProb per atom (= most conservative) ---
  const atoms: TrueOddsResult[] = rawOdds.map(({ atomId, odds }, i) => {
    const rawProb = rawProbs[i];

    // Select the maximum (most pessimistic) trueProb across all methods
    const candidates: [number, DevigMethod][] = [
      [multProbs[i], "multiplicative"],
      [addProbs[i], "additive"],
      [powerProbs[i], "power"],
      [shinProbs[i], "shin"],
    ];

    let trueProb = candidates[0][0];
    let worstCaseMethod: DevigMethod = candidates[0][1];

    for (let j = 1; j < candidates.length; j++) {
      if (candidates[j][0] > trueProb) {
        trueProb = candidates[j][0];
        worstCaseMethod = candidates[j][1];
      }
    }

    const trueOdds = 1 / trueProb;

    // Vig absorbed by this outcome
    const atomVigPct = ((rawProb - trueProb) / rawProb) * 100;

    return {
      atomId,
      rawOdds: odds,
      rawProb,
      trueProb,
      trueOdds,
      vigPct: atomVigPct,
      worstCaseMethod,
    };
  });

  return {
    familyId,
    provider,
    totalImpliedProb,
    vigPct,
    atoms,
  };
}

/**
 * Get true probability for a single atom.
 * Requires calculating the entire family to properly remove vig.
 *
 * @param eventId - Normalized event ID
 * @param familyId - Family ID
 * @param atomId - Atom ID
 * @param provider - Provider to get odds from
 * @returns True odds for the atom, or null if not available
 */
export function getTrueOddsForAtom(
  eventId: string,
  familyId: string,
  atomId: string,
  provider: ProviderKey,
): TrueOddsResult | null {
  const familyOdds = calculateTrueOddsForFamily(eventId, familyId, provider);
  if (!familyOdds) return null;

  return familyOdds.atoms.find((a) => a.atomId === atomId) ?? null;
}

/**
 * Get vig percentage for a family from a specific provider.
 * Useful for quick vig checks without full true odds calculation.
 *
 * @param eventId - Normalized event ID
 * @param familyId - Family ID
 * @param provider - Provider to check
 * @returns Vig percentage (e.g., 5.6 for 5.6%), or null if incomplete
 */
export function getFamilyVig(
  eventId: string,
  familyId: string,
  provider: ProviderKey,
): number | null {
  const familyOdds = calculateTrueOddsForFamily(eventId, familyId, provider);
  return familyOdds?.vigPct ?? null;
}

/**
 * Check if a provider has complete odds for a family.
 *
 * @param eventId - Normalized event ID
 * @param familyId - Family ID
 * @param provider - Provider to check
 * @returns true if all atoms have active (non-suspended) odds
 */
export function hasCompleteOdds(
  eventId: string,
  familyId: string,
  provider: ProviderKey,
): boolean {
  return calculateTrueOddsForFamily(eventId, familyId, provider) !== null;
}
