
import type {
  OddsRecord,
  ProviderKey,
  NormalizedOddsEntry,
  BestAtomOdds,
} from "./types";
import { getFamily } from "./registry";
import { singleton } from "@/lib/util/singleton";
import { recordOddsTick } from "./odds-history";

type ProviderOddsMap = Map<ProviderKey, OddsRecord>;
type AtomOddsMap = Map<string, ProviderOddsMap>;
type FamilyOddsMap = Map<string, AtomOddsMap>;
type EventOddsMap = Map<string, FamilyOddsMap>;

const oddsStore = singleton("atoms:oddsStore", (): EventOddsMap => new Map());

const dirtyFamilies = singleton(
  "atoms:dirtyFamilies",
  (): Set<string> => new Set(),
);

const state = singleton("atoms:state", () => ({
  storeVersion: 0,
  _totalFamilies: 0,
  _totalAtoms: 0,
  _totalOddsRecords: 0,
  _matchedMarkets: 0,
}));


const dirtyCallbackHolder = singleton("atoms:dirtyCallback", () => ({
  fn: null as (() => void) | null,
}));

export function setOnDirtyCallback(cb: (() => void) | null): void {
  dirtyCallbackHolder.fn = cb;
}

export function getStoreVersion(): number {
  return state.storeVersion;
}

export function consumeDirtyFamilies(): Set<string> {
  const snapshot = new Set(dirtyFamilies);
  dirtyFamilies.clear();
  return snapshot;
}

export function parseDirtyKey(key: string): {
  eventId: string;
  familyId: string;
} {
  const idx = key.indexOf("|");
  return { eventId: key.substring(0, idx), familyId: key.substring(idx + 1) };
}

export function hasDirtyFamilies(): boolean {
  return dirtyFamilies.size > 0;
}

export function readdDirtyFamilies(keys: Set<string>): void {
  for (const key of keys) {
    dirtyFamilies.add(key);
  }
}


export function setOdds(entry: NormalizedOddsEntry): void {
  let familyMap = oddsStore.get(entry.event_id);
  if (!familyMap) {
    familyMap = new Map();
    oddsStore.set(entry.event_id, familyMap);
  }

  let atomMap = familyMap.get(entry.family_id);
  if (!atomMap) {
    atomMap = new Map();
    familyMap.set(entry.family_id, atomMap);
    state._totalFamilies++;
  }

  let providerMap = atomMap.get(entry.atom_id);
  if (!providerMap) {
    providerMap = new Map();
    atomMap.set(entry.atom_id, providerMap);
    state._totalAtoms++;
  }

  const existing = providerMap.get(entry.provider);
  const isNewRecord = !existing;
  const valueChanged =
    isNewRecord ||
    existing.odds !== entry.odds ||
    (existing.suspended ?? false) !== (entry.suspended ?? false);

  if (valueChanged) {
    dirtyFamilies.add(`${entry.event_id}|${entry.family_id}`);
    state.storeVersion++;
    dirtyCallbackHolder.fn?.();
  }

  const prevSize = providerMap.size;

  providerMap.set(entry.provider, {
    odds: entry.odds,
    timestamp: entry.timestamp,
    suspended: entry.suspended,
  });

  if (isNewRecord) {
    state._totalOddsRecords++;
    if (prevSize === 1) state._matchedMarkets++;
  }

  if (valueChanged) {
    recordOddsTick(entry);
  }
}

export function setOddsBatch(entries: NormalizedOddsEntry[]): void {
  for (const entry of entries) {
    setOdds(entry);
  }
}

export function clearOddsForEvent(eventId: string): void {
  const familyMap = oddsStore.get(eventId);
  if (familyMap) {
    let anyDirty = false;
    for (const [familyId, atomMap] of familyMap) {
      for (const providerMap of atomMap.values()) {
        state._totalOddsRecords -= providerMap.size;
        if (providerMap.size >= 2) state._matchedMarkets--;
      }
      state._totalAtoms -= atomMap.size;
      dirtyFamilies.add(`${eventId}|${familyId}`);
      state.storeVersion++;
      anyDirty = true;
    }
    state._totalFamilies -= familyMap.size;
    if (anyDirty) {
      dirtyCallbackHolder.fn?.();
    }
  }
  oddsStore.delete(eventId);
}

export function clearAllOdds(): void {
  oddsStore.clear();
  state._totalFamilies = 0;
  state._totalAtoms = 0;
  state._totalOddsRecords = 0;
  state._matchedMarkets = 0;
}

export function pruneOddsForStaleEvents(activeEventIds: Set<string>): number {
  let pruned = 0;
  for (const eventId of oddsStore.keys()) {
    if (!activeEventIds.has(eventId)) {
      clearOddsForEvent(eventId);
      pruned++;
    }
  }
  return pruned;
}

function deleteProviderAtoms(
  eventId: string,
  provider: ProviderKey,
  keepAtomKeys?: Set<string>,
): void {
  const familyMap = oddsStore.get(eventId);
  if (!familyMap) return;

  let anyDirty = false;

  for (const [familyId, atomMap] of familyMap) {
    let familyDirty = false;
    for (const [atomId, providerMap] of atomMap) {
      if (keepAtomKeys?.has(`${familyId}|${atomId}`)) continue;
      const hadRecord = providerMap.delete(provider);
      if (hadRecord) {
        state._totalOddsRecords--;
        if (providerMap.size === 1) state._matchedMarkets--;
        familyDirty = true;
        if (providerMap.size === 0) {
          atomMap.delete(atomId);
          state._totalAtoms--;
        }
      }
    }
    if (familyDirty) {
      dirtyFamilies.add(`${eventId}|${familyId}`);
      state.storeVersion++;
      anyDirty = true;
    }
    if (atomMap.size === 0) {
      familyMap.delete(familyId);
      state._totalFamilies--;
    }
  }

  if (anyDirty) {
    dirtyCallbackHolder.fn?.();
  }

  if (familyMap.size === 0) {
    oddsStore.delete(eventId);
  }
}

export function applyProviderSnapshot(
  eventId: string,
  provider: ProviderKey,
  entries: NormalizedOddsEntry[],
): void {
  const keepAtomKeys = new Set<string>();
  for (const entry of entries) {
    keepAtomKeys.add(`${entry.family_id}|${entry.atom_id}`);
  }

  deleteProviderAtoms(eventId, provider, keepAtomKeys);

  for (const entry of entries) {
    setOdds(entry);
  }
}


export function getOdds(
  eventId: string,
  familyId: string,
  atomId: string,
  provider: ProviderKey,
): OddsRecord | undefined {
  return oddsStore.get(eventId)?.get(familyId)?.get(atomId)?.get(provider);
}

export function getAllOddsForAtom(
  eventId: string,
  familyId: string,
  atomId: string,
): Map<ProviderKey, OddsRecord> {
  const result = oddsStore.get(eventId)?.get(familyId)?.get(atomId);
  return result || new Map();
}

export function getBestOddsForAtom(
  eventId: string,
  familyId: string,
  atomId: string,
): BestAtomOdds | null {
  const providerOdds = getAllOddsForAtom(eventId, familyId, atomId);

  let best: BestAtomOdds | null = null;

  for (const [provider, record] of providerOdds) {
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
      return null;
    }
    result.push(best);
  }

  return result;
}

export function getFamiliesForEvent(eventId: string): string[] {
  const familyMap = oddsStore.get(eventId);
  return familyMap ? Array.from(familyMap.keys()) : [];
}

export function getActiveMarketCountForEvent(eventId: string): number {
  const familyMap = oddsStore.get(eventId);
  if (!familyMap) return 0;
  let count = 0;
  for (const atomMap of familyMap.values()) {
    for (const providerMap of atomMap.values()) {
      if (providerMap.size >= 2) count++;
    }
  }
  return count;
}

export function getAllEventIds(): string[] {
  return Array.from(oddsStore.keys());
}


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

export function getMatchedMarketsForVerification(
  options: {
    eventId?: string;
    familyId?: string;
    limit?: number;
    excludeVerified?: Set<string>;
  } = {},
): MatchedMarketPair[] {
  const results: MatchedMarketPair[] = [];
  const limit = options.limit || 50;

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

        const verifyKey = `${eventId}:${atomId}`;
        if (options.excludeVerified?.has(verifyKey)) continue;

        if (providerMap.size < 2) continue;

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

        if (activeProviders.length < 2) continue;

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

export function getMatchedMarketsCount(): number {
  return state._matchedMarkets;
}


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
