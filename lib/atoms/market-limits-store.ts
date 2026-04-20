/**
 * Per-market stake limit cache.
 *
 * We already walk the Genius Sports market catalog on every odds sync
 * (see `ninewickets-sportsbook.ts`) — each market object carries `min`
 * and `max` fields. Stashing those alongside the odds means the modal
 * can read book-imposed stake limits for free, no extra HTTP round-trip.
 *
 * Keyed by `"<provider>|<normalizedEventId>|<atomId>"`. Entries are
 * written on every odds ingest cycle so staleness matches odds
 * freshness.
 */
import type { ProviderKey } from "./types";

export interface MarketLimitsEntry {
  minBet: number;
  maxBet: number;
  /** Book-native market id, handy for cross-referencing. */
  marketId: string;
  timestamp: number;
}

function key(provider: ProviderKey, eventId: string, atomId: string): string {
  return `${provider}|${eventId}|${atomId}`;
}

// Pin to globalThis so Turbopack / HMR module duplication can't give us
// a fresh empty Map on the reader side. Same idiom used for other
// cross-module in-memory stores in this codebase.
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

/** Diagnostic: return the current store size. */
export function marketLimitsStoreSize(): number {
  return store.size;
}

/** Diagnostic: wipe all entries (used from debug endpoints). */
export function clearMarketLimits(): void {
  store.clear();
}
