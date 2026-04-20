/**
 * Odds Entry Builder
 *
 * Helper functions to construct NormalizedOddsEntry objects.
 * Eliminates repeated familyId lookup + entry construction pattern.
 */

import { getFamilyIdByAtom } from "../atoms/registry";
import type { NormalizedOddsEntry, ProviderKey } from "../atoms/types";

/**
 * Build a single normalized odds entry.
 * Returns null if atomId is null/undefined or familyId lookup fails.
 *
 * @param provider - Provider key (e.g., "pinnacle", "ninewickets-exchange")
 * @param eventId - Normalized event ID
 * @param atomId - Atom ID (can be null/undefined for unmapped selections)
 * @param odds - Odds value (must be > 1 to be valid)
 * @param timestamp - Timestamp in milliseconds
 * @param suspended - Whether the market is suspended (optional)
 */
export function buildOddsEntry(
  provider: ProviderKey,
  eventId: string,
  atomId: string | null | undefined,
  odds: number,
  timestamp: number,
  suspended?: boolean,
): NormalizedOddsEntry | null {
  // Skip null/undefined atomId (unmapped selection)
  if (!atomId) return null;

  // Skip invalid odds
  if (odds <= 1) return null;

  // Look up family ID
  const familyId = getFamilyIdByAtom(atomId);
  if (!familyId) return null;

  return {
    provider,
    event_id: eventId,
    family_id: familyId,
    atom_id: atomId,
    odds,
    timestamp,
    suspended,
  };
}

/**
 * Build multiple normalized odds entries from a list of mappings.
 * Filters out invalid entries automatically.
 *
 * @param provider - Provider key
 * @param eventId - Normalized event ID
 * @param mappings - Array of { atomId, odds } pairs
 * @param timestamp - Timestamp in milliseconds
 */
export function buildOddsEntries(
  provider: ProviderKey,
  eventId: string,
  mappings: Array<{ atomId: string | null | undefined; odds: number }>,
  timestamp: number,
): NormalizedOddsEntry[] {
  return mappings
    .map((m) => buildOddsEntry(provider, eventId, m.atomId, m.odds, timestamp))
    .filter((entry): entry is NormalizedOddsEntry => entry !== null);
}
