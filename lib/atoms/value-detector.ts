/**
 * Value Bet Detector
 *
 * Identifies positive expected value (EV) bets by comparing soft bookmaker
 * odds against Pinnacle's true probability (vig-removed).
 *
 * Formula:
 *   EV = (softOdds × trueProb) - 1
 *   EV% = EV × 100
 *   If EV% > threshold, the bet has positive expected value
 *
 * Kelly Criterion for optimal stake sizing:
 *   kelly = EV / (odds - 1)
 *   stake = bankroll × kelly × fraction (e.g., 0.25 for quarter Kelly)
 */

import type { ProviderKey } from "../providers/registry";
import { getProviderCommission } from "../providers/registry";
import {
  getRuntimeSoftProviders,
  getRuntimeSharpProviders,
} from "../providers/runtime-state";
import { getAllOddsForAtom, getFamiliesForEvent, parseDirtyKey } from "./store";
import { getFamily } from "./registry";
import {
  calculateTrueOddsForFamily,
  type TrueOddsResult,
  type FamilyTrueOdds,
} from "./vig-removal";
import {
  MIN_EV_PCT,
  KELLY_FRACTION,
  VALUE_TOTAL_STAKE,
  MAX_VALUE_ODDS_AGE_MS,
} from "../shared/constants";
import { adjustOddsForCommission } from "../shared/commission";

// ============================================
// Incremental Detection Cache
// ============================================

// Cache: "eventId|familyId" → ValueBet[]
const valueCache = new Map<string, ValueBet[]>();

// Pre-computed vig data cache: "eventId|familyId" → FamilyTrueOdds | null
const vigCache = new Map<string, FamilyTrueOdds | null>();

let valueCacheWarmed = false;

/** Reset the cache (called when events change, e.g., fixture sync) */
export function resetValueCache(): void {
  valueCache.clear();
  vigCache.clear();
  valueCacheWarmed = false;
}

/**
 * Get pre-computed vig data for a family.
 * Used by the dashboard API to avoid re-calculating during serialization.
 */
export function getCachedVigData(
  eventId: string,
  familyId: string,
): FamilyTrueOdds | null | undefined {
  return vigCache.get(`${eventId}|${familyId}`);
}

/**
 * Incremental value bet detection.
 * Only recomputes families that had actual odds changes.
 */
export function detectAllValueBetsIncremental(
  eventIds: string[],
  dirty: Set<string>,
  options: ValueDetectionOptions = {},
): ValueBet[] {
  const activeEvents = new Set(eventIds);

  // First cycle: warm full cache
  if (!valueCacheWarmed) {
    valueCache.clear();
    vigCache.clear();
    for (const eventId of eventIds) {
      const families = getFamiliesForEvent(eventId);
      for (const familyId of families) {
        const key = `${eventId}|${familyId}`;
        const vbs = detectValueForFamily(eventId, familyId, options);
        valueCache.set(key, vbs);
        // Cache vig data for API use
        const sharpProviders = getRuntimeSharpProviders();
        if (sharpProviders.length > 0) {
          vigCache.set(
            key,
            calculateTrueOddsForFamily(eventId, familyId, sharpProviders[0]),
          );
        }
      }
    }
    valueCacheWarmed = true;
  } else {
    // Clean up removed events
    for (const key of valueCache.keys()) {
      const { eventId } = parseDirtyKey(key);
      if (!activeEvents.has(eventId)) {
        valueCache.delete(key);
        vigCache.delete(key);
      }
    }

    // Recompute ONLY dirty families
    for (const dirtyKey of dirty) {
      const { eventId, familyId } = parseDirtyKey(dirtyKey);
      if (!activeEvents.has(eventId)) {
        valueCache.delete(dirtyKey);
        vigCache.delete(dirtyKey);
        continue;
      }
      valueCache.set(
        dirtyKey,
        detectValueForFamily(eventId, familyId, options),
      );
      // Update vig cache
      const sharpProviders = getRuntimeSharpProviders();
      if (sharpProviders.length > 0) {
        vigCache.set(
          dirtyKey,
          calculateTrueOddsForFamily(eventId, familyId, sharpProviders[0]),
        );
      }
    }
  }

  // Collect all value bets, sorted by EV%
  const result: ValueBet[] = [];
  for (const [key, vbs] of valueCache) {
    const { eventId } = parseDirtyKey(key);
    if (activeEvents.has(eventId)) result.push(...vbs);
  }
  result.sort((a, b) => b.evPct - a.evPct);
  return result;
}

// ============================================
// Types
// ============================================

export interface ValueBet {
  id: string;
  eventId: string;
  familyId: string;
  atomId: string;

  // Sharp benchmark (true probability source)
  sharpProvider: ProviderKey;
  sharpOdds: number; // Original odds from sharp book
  trueProb: number; // Vig-removed probability
  trueOdds: number; // 1 / trueProb

  // Soft bookmaker (value source)
  softProvider: ProviderKey;
  softOdds: number; // Raw odds from provider
  adjustedSoftOdds: number; // Commission-adjusted odds
  impliedProb: number; // 1 / adjustedSoftOdds

  // Commission
  commissionPct: number; // Commission percentage applied

  // Value metrics (calculated using adjusted odds)
  evPct: number; // Expected value percentage
  edge: number; // Raw edge (EV as decimal)
  kellyFraction: number; // Full Kelly stake fraction
  kellyStake: number; // Recommended stake (fractional Kelly)

  // Metadata
  detectedAt: Date;
  timestamp: number; // Soft odds timestamp (for staleness)
}

export interface ValueDetectionOptions {
  minEvPct?: number; // Minimum EV% to report (default 2%)
  kellyFraction?: number; // Fractional Kelly multiplier (default 0.25)
  totalStake?: number; // Bankroll for Kelly calculation (default 1000)
  maxOddsAgeMs?: number; // Max age of soft odds in ms
}

export interface ValueDetectionStats {
  eventsScanned: number;
  familiesScanned: number;
  atomsCompared: number;
  valueBetsFound: number;
  avgEvPct: number;
  bestEvPct: number;
}

// ============================================
// Detection Functions
// ============================================

/**
 * Detect value bets for a single atom across all soft providers.
 * Compares each soft provider's odds against the sharp provider's true odds.
 *
 * @param eventId - Normalized event ID
 * @param familyId - Family ID
 * @param atomId - Atom ID
 * @param trueOdds - Pre-calculated true odds for this atom (from vig removal)
 * @param sharpProvider - The sharp provider used as benchmark
 * @param options - Detection options
 * @returns Array of value bets found (may have multiple if multiple soft books have value)
 */
export function detectValueForAtom(
  eventId: string,
  familyId: string,
  atomId: string,
  trueOdds: TrueOddsResult,
  sharpProvider: ProviderKey,
  options: ValueDetectionOptions = {},
): ValueBet[] {
  const {
    minEvPct = MIN_EV_PCT,
    kellyFraction = KELLY_FRACTION,
    totalStake = VALUE_TOTAL_STAKE,
    maxOddsAgeMs = MAX_VALUE_ODDS_AGE_MS,
  } = options;

  const valueBets: ValueBet[] = [];
  const softProviders = getRuntimeSoftProviders();
  const now = Date.now();

  const allOdds = getAllOddsForAtom(eventId, familyId, atomId);

  // Sharp snapshot age — how stale the sharp reference was when this atom was
  // evaluated. Null when the sharp record isn't in the store (shouldn't happen
  // if vig removal succeeded, but keep defensive).
  const sharpRecord = allOdds.get(sharpProvider);
  const sharpOddsAgeMs =
    sharpRecord != null ? now - sharpRecord.timestamp : null;

  // Latency gate: if the sharp snapshot is older than the allowed window,
  // any "value" detected is likely phantom — caused by the sharp cache
  // lagging real-time price. Skip the entire atom; no soft provider can be
  // fairly compared against a stale sharp.
  //
  // We reuse maxOddsAgeMs (default 90s). Staleness beyond that means either
  // Pinnacle fetch failed this cycle or the event is past kickoff+grace and
  // no longer being fetched. Either way, don't emit bets from it.
  if (sharpOddsAgeMs == null || sharpOddsAgeMs > maxOddsAgeMs) {
    return valueBets;
  }

  for (const softProvider of softProviders) {
    const softRecord = allOdds.get(softProvider);
    if (!softRecord || softRecord.suspended) continue;

    // Skip stale odds
    const ageMs = now - softRecord.timestamp;
    if (ageMs > maxOddsAgeMs) continue;

    // Skip invalid odds
    if (softRecord.odds <= 1) continue;

    const rawSoftOdds = softRecord.odds;

    // Get commission for this provider and calculate adjusted odds
    const commissionPct = getProviderCommission(softProvider);
    const adjustedSoftOdds = adjustOddsForCommission(
      rawSoftOdds,
      commissionPct,
    );

    // Implied probability using adjusted odds (what you actually get)
    const impliedProb = 1 / adjustedSoftOdds;

    // Calculate Expected Value using ADJUSTED odds
    // EV = (adjustedOdds × trueProb) - 1
    // This is the expected profit per unit staked after commission
    const edge = adjustedSoftOdds * trueOdds.trueProb - 1;
    const evPct = edge * 100;

    // Only report positive EV above threshold
    if (evPct < minEvPct) continue;

    // Calculate Kelly criterion using adjusted odds
    // kelly = edge / (adjustedOdds - 1)
    // This gives the fraction of bankroll to bet for max growth
    const fullKelly = edge / (adjustedSoftOdds - 1);
    const fractionalKelly = fullKelly * kellyFraction;

    // Calculate actual stake (capped at reasonable amounts)
    const kellyStake = Math.max(
      0,
      Math.min(fractionalKelly * totalStake, totalStake * 0.1),
    );

    valueBets.push({
      id: `${eventId}|${familyId}|${atomId}`,
      eventId,
      familyId,
      atomId,
      sharpProvider,
      sharpOdds: trueOdds.rawOdds,
      trueProb: trueOdds.trueProb,
      trueOdds: trueOdds.trueOdds,
      softProvider,
      softOdds: rawSoftOdds, // Raw odds from provider
      adjustedSoftOdds, // Commission-adjusted odds
      impliedProb,
      commissionPct, // Commission percentage applied
      evPct: Math.round(evPct * 100) / 100, // Round to 2 decimals
      edge,
      kellyFraction: fractionalKelly,
      kellyStake: Math.round(kellyStake * 100) / 100, // Round to cents
      detectedAt: new Date(),
      timestamp: softRecord.timestamp,
    });
  }

  // Keep only the best value bet per atom across all soft providers
  if (valueBets.length === 0) return [];
  const best = valueBets.reduce((a, b) => (a.evPct > b.evPct ? a : b));
  return [best];
}

/**
 * Detect all value bets for a family.
 * Gets true odds from sharp provider, then checks all atoms against soft providers.
 *
 * @param eventId - Normalized event ID
 * @param familyId - Family ID
 * @param options - Detection options
 * @returns Array of value bets found in this family
 */
export function detectValueForFamily(
  eventId: string,
  familyId: string,
  options: ValueDetectionOptions = {},
): ValueBet[] {
  const family = getFamily(familyId);
  if (!family) return [];

  // Get sharp provider (typically Pinnacle)
  const sharpProviders = getRuntimeSharpProviders();
  if (sharpProviders.length === 0) {
    // No sharp providers configured - can't detect value
    return [];
  }

  // Use first enabled sharp provider as benchmark
  const sharpProvider = sharpProviders[0];

  // Calculate true odds for the entire family (vig removal)
  const familyTrueOdds = calculateTrueOddsForFamily(
    eventId,
    familyId,
    sharpProvider,
  );
  if (!familyTrueOdds) {
    // Missing sharp odds for some atoms - can't calculate true probability
    return [];
  }

  // Detect value for each atom in the family
  const valueBets: ValueBet[] = [];
  for (const atomTrueOdds of familyTrueOdds.atoms) {
    const atomValues = detectValueForAtom(
      eventId,
      familyId,
      atomTrueOdds.atomId,
      atomTrueOdds,
      sharpProvider,
      options,
    );
    valueBets.push(...atomValues);
  }

  return valueBets;
}

/**
 * Detect all value bets for an event.
 *
 * @param eventId - Normalized event ID
 * @param options - Detection options
 * @returns Array of value bets found for this event
 */
export function detectValueForEvent(
  eventId: string,
  options: ValueDetectionOptions = {},
): ValueBet[] {
  const families = getFamiliesForEvent(eventId);
  const valueBets: ValueBet[] = [];

  for (const familyId of families) {
    const familyValues = detectValueForFamily(eventId, familyId, options);
    valueBets.push(...familyValues);
  }

  return valueBets;
}

/**
 * Detect all value bets across all events.
 * Returns sorted by EV% (highest first).
 *
 * @param eventIds - Array of event IDs to scan
 * @param options - Detection options
 * @returns Array of value bets, sorted by EV% descending
 */
export function detectAllValueBets(
  eventIds: string[],
  options: ValueDetectionOptions = {},
): ValueBet[] {
  const valueBets: ValueBet[] = [];

  for (const eventId of eventIds) {
    const eventValues = detectValueForEvent(eventId, options);
    valueBets.push(...eventValues);
  }

  // Sort by EV% (highest first)
  valueBets.sort((a, b) => b.evPct - a.evPct);

  return valueBets;
}

/**
 * Detect all value bets and return statistics.
 *
 * @param eventIds - Array of event IDs to scan
 * @param options - Detection options
 * @returns Object containing value bets and detection statistics
 */
export function detectAllValueBetsWithStats(
  eventIds: string[],
  options: ValueDetectionOptions = {},
): { valueBets: ValueBet[]; stats: ValueDetectionStats } {
  let familiesScanned = 0;
  let atomsCompared = 0;

  const valueBets: ValueBet[] = [];

  for (const eventId of eventIds) {
    const families = getFamiliesForEvent(eventId);

    for (const familyId of families) {
      familiesScanned++;

      const family = getFamily(familyId);
      if (family) {
        atomsCompared += family.atoms.length;
      }

      const familyValues = detectValueForFamily(eventId, familyId, options);
      valueBets.push(...familyValues);
    }
  }

  // Sort by EV% (highest first)
  valueBets.sort((a, b) => b.evPct - a.evPct);

  // Calculate stats
  const avgEvPct =
    valueBets.length > 0
      ? valueBets.reduce((sum, vb) => sum + vb.evPct, 0) / valueBets.length
      : 0;
  const bestEvPct = valueBets.length > 0 ? valueBets[0].evPct : 0;

  return {
    valueBets,
    stats: {
      eventsScanned: eventIds.length,
      familiesScanned,
      atomsCompared,
      valueBetsFound: valueBets.length,
      avgEvPct: Math.round(avgEvPct * 100) / 100,
      bestEvPct,
    },
  };
}

/**
 * Validate that a value bet is still valid (odds haven't changed unfavorably).
 *
 * @param vb - Value bet to validate
 * @returns true if the value bet is still valid
 */
export function validateValueBet(vb: ValueBet): boolean {
  const allOdds = getAllOddsForAtom(vb.eventId, vb.familyId, vb.atomId);

  // Check soft odds still exist and haven't decreased significantly
  const currentSoftOdds = allOdds.get(vb.softProvider);
  if (!currentSoftOdds || currentSoftOdds.suspended) return false;

  // Odds decreased below what we recorded - value may be gone
  if (currentSoftOdds.odds < vb.softOdds * 0.98) return false;

  // Re-calculate EV with current odds using commission-adjusted odds
  const commissionPct = getProviderCommission(vb.softProvider);
  const adjustedOdds = adjustOddsForCommission(
    currentSoftOdds.odds,
    commissionPct,
  );
  const currentEdge = adjustedOdds * vb.trueProb - 1;
  const currentEvPct = currentEdge * 100;

  // Still positive EV?
  return currentEvPct > 0;
}

/**
 * Filter value bets to only include those above a minimum EV threshold.
 *
 * @param valueBets - Array of value bets
 * @param minEvPct - Minimum EV% to include
 * @returns Filtered array
 */
export function filterByMinEv(
  valueBets: ValueBet[],
  minEvPct: number,
): ValueBet[] {
  return valueBets.filter((vb) => vb.evPct >= minEvPct);
}

/**
 * Group value bets by event.
 *
 * @param valueBets - Array of value bets
 * @returns Map of eventId to value bets
 */
export function groupByEvent(valueBets: ValueBet[]): Map<string, ValueBet[]> {
  const grouped = new Map<string, ValueBet[]>();

  for (const vb of valueBets) {
    const list = grouped.get(vb.eventId) || [];
    list.push(vb);
    grouped.set(vb.eventId, list);
  }

  return grouped;
}

/**
 * Group value bets by soft provider.
 *
 * @param valueBets - Array of value bets
 * @returns Map of provider to value bets
 */
export function groupByProvider(
  valueBets: ValueBet[],
): Map<ProviderKey, ValueBet[]> {
  const grouped = new Map<ProviderKey, ValueBet[]>();

  for (const vb of valueBets) {
    const list = grouped.get(vb.softProvider) || [];
    list.push(vb);
    grouped.set(vb.softProvider, list);
  }

  return grouped;
}
