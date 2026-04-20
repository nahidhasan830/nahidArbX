/**
 * Vig Removal - True Probability Calculation
 *
 * Removes the bookmaker margin (vig) from odds to get true probabilities.
 * Uses the "balanced margin removal" method which distributes the margin
 * equally across all outcomes in a family.
 *
 * Sharp bookmakers like Pinnacle have ~2% vig. After removal, the true
 * probabilities sum to exactly 1.0, representing the actual expected outcomes.
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
  trueProb: number; // After vig removal (sums to 1.0 across family)
  trueOdds: number; // 1 / trueProb
  vigPct: number; // Vig % applied to this outcome (proportional)
}

export interface FamilyTrueOdds {
  familyId: string;
  provider: ProviderKey;
  totalImpliedProb: number; // Sum of 1/odds (includes vig, e.g., 1.056)
  vigPct: number; // Total family vig (e.g., 5.6%)
  atoms: TrueOddsResult[];
}

// ============================================
// Vig Removal Functions
// ============================================

/**
 * Calculate true odds for a family from a specific provider.
 * Uses balanced margin removal: trueProb = rawProb / sumOfRawProbs
 *
 * This method assumes the bookmaker applies margin proportionally to all
 * outcomes, which is a reasonable approximation for sharp books like Pinnacle.
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

  // Calculate true probabilities using balanced removal
  // trueProb = rawProb / totalImpliedProb (normalizes to sum to 1.0)
  const atoms: TrueOddsResult[] = rawOdds.map(({ atomId, odds }) => {
    const rawProb = 1 / odds;
    const trueProb = rawProb / totalImpliedProb; // Normalize to sum to 1
    const trueOdds = 1 / trueProb;

    // Proportional vig per outcome
    const atomVigPct = vigPct * (rawProb / totalImpliedProb);

    return {
      atomId,
      rawOdds: odds,
      rawProb,
      trueProb,
      trueOdds,
      vigPct: atomVigPct,
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
