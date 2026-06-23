import type { ProviderKey } from "./types";

export interface MarketLimitsEntry {
  minBet: number;
  maxBet: number;
  marketId: string;
  timestamp: number;
}

function key(provider: ProviderKey, eventId: string, atomId: string): string {
  return `${provider}|${eventId}|${atomId}`;
}

declare global {
  var __nahidArbX_marketLimitsStore__:
    | Map<string, MarketLimitsEntry>
    | undefined;
}
const store: Map<string, MarketLimitsEntry> =
  globalThis.__nahidArbX_marketLimitsStore__ ??
  (globalThis.__nahidArbX_marketLimitsStore__ = new Map());

export function setMarketLimits(
  provider: ProviderKey,
  eventId: string,
  atomId: string,
  entry: MarketLimitsEntry,
): void {
  store.set(key(provider, eventId, atomId), entry);
}

export function getMarketLimits(
  provider: ProviderKey,
  eventId: string,
  atomId: string,
): MarketLimitsEntry | null {
  return store.get(key(provider, eventId, atomId)) ?? null;
}

export function marketLimitsStoreSize(): number {
  return store.size;
}

export function clearMarketLimits(): void {
  store.clear();
}

export function pruneMarketLimitsForStaleEvents(
  activeEventIds: Set<string>,
): number {
  let pruned = 0;
  for (const key of store.keys()) {
    const parts = key.split("|");
    if (parts.length !== 3) continue;
    const eventId = parts[1];
    if (!activeEventIds.has(eventId)) {
      store.delete(key);
      pruned++;
    }
  }
  return pruned;
}
