/**
 * Atoms Odds Store
 *
 * Hierarchical storage for atom-based odds.
 * Structure: eventId → familyId → atomId → provider → OddsRecord
 */

import type {
  OddsRecord,
  ProviderKey,
  NormalizedOddsEntry,
  BestAtomOdds,
} from "./types";
import { getFamily } from "./registry";
import { singleton } from "@/lib/util/singleton";

// Type definitions for nested maps
// ProviderKey directly encodes source (e.g., "ninewickets-exchange")
type ProviderOddsMap = Map<ProviderKey, OddsRecord>;
type AtomOddsMap = Map<string, ProviderOddsMap>;
type FamilyOddsMap = Map<string, AtomOddsMap>;
type EventOddsMap = Map<string, FamilyOddsMap>;

// Pinned to globalThis so the scheduler (started from instrumentation.ts)
// and route handlers share the same data — otherwise Turbopack gives each
// module graph its own empty Map and the UI sees no odds.
const oddsStore = singleton("atoms:oddsStore", (): EventOddsMap => new Map());

const dirtyFamilies = singleton(
  "atoms:dirtyFamilies",
  (): Set<string> => new Set(),
);

const state = singleton("atoms:state", () => ({
  fetchCycleWritten: null as Set<string> | null,
  storeVersion: 0,
  _totalFamilies: 0,
  _totalAtoms: 0,
  _totalOddsRecords: 0,
  _matchedMarkets: 0,
}));

/** Get current store version (for ETag / cache invalidation) */
export function getStoreVersion(): number {
  return state.storeVersion;
}

/**
 * Consume dirty families since last call. Returns snapshot and clears the set.
 * Call once per detection cycle, pass result to both arb and value detectors.
 */
export function consumeDirtyFamilies(): Set<string> {
  const snapshot = new Set(dirtyFamilies);
  dirtyFamilies.clear();
  return snapshot;
}

/** Parse a dirty key back to eventId + familyId */
export function parseDirtyKey(key: string): {
  eventId: string;
  familyId: string;
} {
  const idx = key.indexOf("|");
  return { eventId: key.substring(0, idx), familyId: key.substring(idx + 1) };
}

/** Check if there are any pending dirty families */
export function hasDirtyFamilies(): boolean {
  return dirtyFamilies.size > 0;
}

// ============================================
// Write Operations
// ============================================

/**
 * Set odds for a single atom from a specific provider
 */
export function setOdds(entry: NormalizedOddsEntry): void {
  // Get or create event map
  let familyMap = oddsStore.get(entry.event_id);
  if (!familyMap) {
    familyMap = new Map();
    oddsStore.set(entry.event_id, familyMap);
  }

  // Get or create family map
  let atomMap = familyMap.get(entry.family_id);
  if (!atomMap) {
    atomMap = new Map();
    familyMap.set(entry.family_id, atomMap);
    state._totalFamilies++;
  }

  // Get or create atom map
  let providerMap = atomMap.get(entry.atom_id);
  if (!providerMap) {
    providerMap = new Map();
    atomMap.set(entry.atom_id, providerMap);
    state._totalAtoms++;
  }

  // --- Dirty check: only mark dirty if actual value changed ---
  const existing = providerMap.get(entry.provider);
  const isNewRecord = !existing;
  const valueChanged =
    isNewRecord ||
    existing.odds !== entry.odds ||
    (existing.suspended ?? false) !== (entry.suspended ?? false);

  if (valueChanged) {
    dirtyFamilies.add(`${entry.event_id}|${entry.family_id}`);
    state.storeVersion++;
  }

  // Track matched markets counter
  const prevSize = providerMap.size;

  // Set odds for provider (provider name encodes source, e.g., "ninewickets-exchange")
  providerMap.set(entry.provider, {
    odds: entry.odds,
    timestamp: entry.timestamp,
    suspended: entry.suspended,
  });

  // Update running counters
  if (isNewRecord) {
    state._totalOddsRecords++;
    // Crossed the 2-provider threshold → new matched market
    if (prevSize === 1) state._matchedMarkets++;
  }

  // Track write during fetch cycle
  if (state.fetchCycleWritten) {
    state.fetchCycleWritten.add(
      `${entry.event_id}|${entry.family_id}|${entry.atom_id}|${entry.provider}`,
    );
  }
}

/**
 * Set multiple odds entries in batch
 */
export function setOddsBatch(entries: NormalizedOddsEntry[]): void {
  for (const entry of entries) {
    setOdds(entry);
  }
}

/**
 * Clear odds for a single event (before re-fetch to remove stale families)
 */
export function clearOddsForEvent(eventId: string): void {
  const familyMap = oddsStore.get(eventId);
  if (familyMap) {
    for (const atomMap of familyMap.values()) {
      for (const providerMap of atomMap.values()) {
        state._totalOddsRecords -= providerMap.size;
        if (providerMap.size >= 2) state._matchedMarkets--;
      }
      state._totalAtoms -= atomMap.size;
    }
    state._totalFamilies -= familyMap.size;
  }
  oddsStore.delete(eventId);
}

/**
 * Clear entire store
 */
export function clearAllOdds(): void {
  oddsStore.clear();
  state._totalFamilies = 0;
  state._totalAtoms = 0;
  state._totalOddsRecords = 0;
  state._matchedMarkets = 0;
}

/**
 * Begin a fetch cycle. All setOdds() calls after this will be tracked.
 * Call endFetchCycleCleanup() after fetching to remove stale entries.
 */
export function beginFetchCycle(): void {
  state.fetchCycleWritten = new Set();
}

/**
 * End fetch cycle and remove stale entries for the given events.
 * Any odds entry not written via setOdds() during this cycle is deleted.
 */
export function endFetchCycleCleanup(eventIds: string[]): void {
  if (!state.fetchCycleWritten) return;
  const written = state.fetchCycleWritten;
  state.fetchCycleWritten = null;

  for (const eventId of eventIds) {
    const familyMap = oddsStore.get(eventId);
    if (!familyMap) continue;

    for (const [familyId, atomMap] of familyMap) {
      let familyDirty = false;

      for (const [atomId, providerMap] of atomMap) {
        const sizeBefore = providerMap.size;
        for (const [provider] of providerMap) {
          const key = `${eventId}|${familyId}|${atomId}|${provider}`;
          if (!written.has(key)) {
            providerMap.delete(provider);
            state._totalOddsRecords--;
            familyDirty = true; // Deletion is a value change
          }
        }
        // Update matched markets counter if crossed below threshold
        if (sizeBefore >= 2 && providerMap.size < 2) state._matchedMarkets--;

        if (providerMap.size === 0) {
          atomMap.delete(atomId);
          state._totalAtoms--;
        }
      }
      if (atomMap.size === 0) {
        familyMap.delete(familyId);
        state._totalFamilies--;
      }

      // Mark family dirty if any stale entries were removed
      if (familyDirty) {
        dirtyFamilies.add(`${eventId}|${familyId}`);
        state.storeVersion++;
      }
    }
    if (familyMap.size === 0) oddsStore.delete(eventId);
  }
}

// ============================================
// Read Operations
// ============================================

/**
 * Get odds for a specific atom from a specific provider
 */
export function getOdds(
  eventId: string,
  familyId: string,
  atomId: string,
  provider: ProviderKey,
): OddsRecord | undefined {
  return oddsStore.get(eventId)?.get(familyId)?.get(atomId)?.get(provider);
}

/**
 * Get all odds for an atom across all providers.
 * Returns Map with provider keys (e.g., "pinnacle", "ninewickets-exchange")
 */
export function getAllOddsForAtom(
  eventId: string,
  familyId: string,
  atomId: string,
): Map<ProviderKey, OddsRecord> {
  const result = oddsStore.get(eventId)?.get(familyId)?.get(atomId);
  return result || new Map();
}

/**
 * Get best odds for a specific atom across all providers.
 * Excludes suspended odds from consideration.
 */
export function getBestOddsForAtom(
  eventId: string,
  familyId: string,
  atomId: string,
): BestAtomOdds | null {
  const providerOdds = getAllOddsForAtom(eventId, familyId, atomId);

  let best: BestAtomOdds | null = null;

  for (const [provider, record] of providerOdds) {
    // Skip suspended odds
    if (record.suspended) continue;

    if (!best || record.odds > best.odds) {
      best = {
        atomId,
        odds: record.odds,
        provider,
        timestamp: record.timestamp,
      };
    }
  }

  return best;
}

/**
 * Get best odds for all atoms in a family.
 * Returns null if ANY atom in the family is missing odds.
 */
export function getBestOddsForFamily(
  eventId: string,
  familyId: string,
): BestAtomOdds[] | null {
  const family = getFamily(familyId);
  if (!family) return null;

  const result: BestAtomOdds[] = [];

  for (const atomId of family.atoms) {
    const best = getBestOddsForAtom(eventId, familyId, atomId);
    if (!best) {
      // Missing odds for this atom — incomplete family coverage.
      return null;
    }
    result.push(best);
  }

  return result;
}

/**
 * Get all families with odds for an event
 */
export function getFamiliesForEvent(eventId: string): string[] {
  const familyMap = oddsStore.get(eventId);
  return familyMap ? Array.from(familyMap.keys()) : [];
}

/**
 * Get all events in the store
 */
export function getAllEventIds(): string[] {
  return Array.from(oddsStore.keys());
}

// ============================================
// Market Verification
// ============================================

/**
 * Matched market pair for AI verification
 */
export interface MatchedMarketPair {
  eventId: string;
  familyId: string;
  atomId: string;
  providerA: {
    provider: ProviderKey;
    odds: number;
    timestamp: number;
  };
  providerB: {
    provider: ProviderKey;
    odds: number;
    timestamp: number;
  };
}

/**
 * Get matched markets for AI verification.
 * Returns atom/provider pairs where 2+ providers have odds for the same atom.
 * Used to verify that different providers are actually betting on the same thing.
 */
export function getMatchedMarketsForVerification(
  options: {
    eventId?: string;
    familyId?: string;
    limit?: number;
    excludeVerified?: Set<string>; // Keys in format "eventId:atomId"
  } = {},
): MatchedMarketPair[] {
  const results: MatchedMarketPair[] = [];
  const limit = options.limit || 50;

  // Iterate through the store
  const eventIds = options.eventId
    ? [options.eventId]
    : Array.from(oddsStore.keys());

  for (const eventId of eventIds) {
    if (results.length >= limit) break;

    const familyMap = oddsStore.get(eventId);
    if (!familyMap) continue;

    const familyIds = options.familyId
      ? [options.familyId]
      : Array.from(familyMap.keys());

    for (const familyId of familyIds) {
      if (results.length >= limit) break;

      const atomMap = familyMap.get(familyId);
      if (!atomMap) continue;

      for (const [atomId, providerMap] of atomMap) {
        if (results.length >= limit) break;

        // Skip if already verified
        const verifyKey = `${eventId}:${atomId}`;
        if (options.excludeVerified?.has(verifyKey)) continue;

        // Need at least 2 providers
        if (providerMap.size < 2) continue;

        // Get all providers with active (non-suspended) odds
        const activeProviders: Array<{
          provider: ProviderKey;
          odds: number;
          timestamp: number;
        }> = [];
        for (const [provider, record] of providerMap) {
          if (!record.suspended && record.odds > 1) {
            activeProviders.push({
              provider,
              odds: record.odds,
              timestamp: record.timestamp,
            });
          }
        }

        // Need at least 2 active providers
        if (activeProviders.length < 2) continue;

        // Create pairs for verification (just use first two for simplicity)
        // Sort by odds to pair highest vs lowest (most likely to spot differences)
        activeProviders.sort((a, b) => b.odds - a.odds);

        results.push({
          eventId,
          familyId,
          atomId,
          providerA: activeProviders[0],
          providerB: activeProviders[activeProviders.length - 1],
        });
      }
    }
  }

  return results;
}

/**
 * Get count of matched markets (atoms with 2+ providers).
 * O(1) via running counter maintained in setOdds/cleanup.
 */
export function getMatchedMarketsCount(): number {
  return state._matchedMarkets;
}

// ============================================
// Statistics
// ============================================

/**
 * Get store statistics.
 * O(1) via running counters maintained in setOdds/cleanup.
 */
export function getStoreStats(): {
  eventCount: number;
  totalFamilies: number;
  totalAtoms: number;
  totalOddsRecords: number;
} {
  return {
    eventCount: oddsStore.size,
    totalFamilies: state._totalFamilies,
    totalAtoms: state._totalAtoms,
    totalOddsRecords: state._totalOddsRecords,
  };
}
