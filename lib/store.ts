import type { NormalizedEvent } from "./types";
import type { ValueBet } from "./atoms/types";
import { PROVIDER_REGISTRY, type ProviderKey } from "./providers/registry";

// Use ProviderKey from registry
type Provider = ProviderKey;

export interface ProviderStatus {
  status: "ok" | "error" | "pending";
  lastFetch: Date | null;
  error?: string;
}

// Sync phase tracking
export type SyncPhase = "idle" | "fixtures" | "matching" | "markets";
export type MarketsSubPhase = ProviderKey; // Derived from registry

export interface PhaseProgress {
  current: number;
  total: number;
  subPhase?: MarketsSubPhase;
}

export interface SyncStatus {
  isSchedulerActive: boolean; // Background sync job is scheduled
  isSyncing: boolean; // Currently pulling data from providers
  lastSyncStart: Date | null;
  lastSyncEnd: Date | null;
  syncInterval: number; // ms between syncs
  lastSyncDuration: number | null; // ms
  lastMarketsCount: number; // Total markets fetched
  // Phase tracking
  currentPhase: SyncPhase;
  phaseProgress: PhaseProgress | null;
}

interface Store {
  events: Map<string, NormalizedEvent>;
  valueBets: ValueBet[];
  providerStatus: Record<Provider, ProviderStatus>;
  lastUpdate: Date | null;
}

// Initialize provider status dynamically from registry
function initializeProviderStatus(): Record<Provider, ProviderStatus> {
  const status = {} as Record<Provider, ProviderStatus>;
  for (const id of Object.keys(PROVIDER_REGISTRY) as Provider[]) {
    status[id] = { status: "pending", lastFetch: null };
  }
  return status;
}

// Track raw event count before matching
interface CachedStats {
  providerCounts: Record<string, number>;
  matchedCount: number;
  totalEvents: number;
}

// Persist the singleton on globalThis so HMR (which re-evaluates this module
// per edit) doesn't give each importer its own empty store. Without this,
// the background fetcher's `setEvents` writes to one module instance while
// route handlers read from another, and you see store=0 despite data flowing.
declare global {
  var __nahidArbxStore:
    | {
        store: Store;
        syncStatus: SyncStatus;
        rawEventCount: number;
        cachedStats: CachedStats | null;
      }
    | undefined;
}

function initRoot() {
  return {
    store: {
      events: new Map<string, NormalizedEvent>(),
      valueBets: [] as ValueBet[],
      providerStatus: initializeProviderStatus(),
      lastUpdate: null as Date | null,
    },
    syncStatus: {
      isSchedulerActive: false,
      isSyncing: false,
      lastSyncStart: null,
      lastSyncEnd: null,
      syncInterval: 30000,
      lastSyncDuration: null,
      lastMarketsCount: 0,
      currentPhase: "idle",
      phaseProgress: null,
    } satisfies SyncStatus,
    rawEventCount: 0,
    cachedStats: null as CachedStats | null,
  };
}

const root = (globalThis.__nahidArbxStore ??= initRoot());
const store: Store = root.store;

function computeStats(): CachedStats {
  const events = Array.from(store.events.values());
  const providerCounts: Record<string, number> = {};
  for (const id of Object.keys(PROVIDER_REGISTRY)) {
    providerCounts[id] = events.filter(
      (e) => e.providers[id as ProviderKey],
    ).length;
  }
  return {
    providerCounts,
    matchedCount: events.filter((e) => Object.keys(e.providers).length > 1)
      .length,
    totalEvents: events.length,
  };
}

export function getCachedStats(): CachedStats {
  if (!root.cachedStats) {
    root.cachedStats = computeStats();
  }
  return root.cachedStats;
}

// Sync status (background data sync from providers) — globalThis-backed
// so HMR doesn't fracture the singleton across route handlers.
const syncStatus: SyncStatus = root.syncStatus;

// Single event lookup
export function getEvent(eventId: string): NormalizedEvent | undefined {
  return store.events.get(eventId);
}

// Events
export function setEvents(events: NormalizedEvent[], rawCount?: number): void {
  // Build set of new event IDs for fast lookup
  const newEventIds = new Set(events.map((e) => e.id));

  // Remove events that are NOT in new data
  // This diff-and-merge approach prevents race conditions where events
  // disappear briefly during sync, causing refresh to fail with "Unknown" team names
  const existingIds = Array.from(store.events.keys());
  for (const id of existingIds) {
    if (!newEventIds.has(id)) {
      store.events.delete(id);
    }
  }

  // Add/update events from new data
  for (const event of events) {
    store.events.set(event.id, event);
  }

  store.lastUpdate = new Date();
  root.cachedStats = null; // Invalidate cached stats
  if (rawCount !== undefined) {
    root.rawEventCount = rawCount;
  }
}

export function getEvents(): NormalizedEvent[] {
  return Array.from(store.events.values());
}

// Get only matched events (2+ providers)
export function getMatchedEvents(): NormalizedEvent[] {
  return Array.from(store.events.values()).filter(
    (e) => Object.keys(e.providers).length > 1,
  );
}

// ============================================
// Value Bets
// ============================================

// Set all value bets (replaces existing)
export function setValueBets(vbs: ValueBet[]): void {
  // Pre-sort by EV% (highest first) - avoids sorting on every API request
  store.valueBets = [...vbs].sort((a, b) => b.evPct - a.evPct);
  store.lastUpdate = new Date();
  root.cachedStats = null; // Invalidate cached stats
}

// Get all value bets
export function getValueBets(): ValueBet[] {
  return store.valueBets;
}

// Update value bets for a single event without touching others
export function updateValueBetsForEvent(
  eventId: string,
  newVbs: ValueBet[],
): void {
  store.valueBets = [
    ...store.valueBets.filter((vb) => vb.eventId !== eventId),
    ...newVbs,
  ];
  // Re-sort by EV% to maintain order
  store.valueBets.sort((a, b) => b.evPct - a.evPct);
  store.lastUpdate = new Date();
  root.cachedStats = null; // Invalidate cached stats
}

// Get value bets grouped by event
export function getValueBetsByEvent(): Map<string, ValueBet[]> {
  const grouped = new Map<string, ValueBet[]>();
  for (const vb of store.valueBets) {
    const list = grouped.get(vb.eventId) || [];
    list.push(vb);
    grouped.set(vb.eventId, list);
  }
  return grouped;
}

// Provider Status
export function setProviderStatus(
  provider: Provider,
  status: ProviderStatus,
): void {
  store.providerStatus[provider] = status;
}

export function getProviderStatus(provider: Provider): ProviderStatus {
  return store.providerStatus[provider];
}

export function getAllProviderStatus(): Record<Provider, ProviderStatus> {
  return store.providerStatus;
}

// Last Update
export function getLastUpdate(): Date | null {
  return store.lastUpdate;
}

// Overall health
export function getOverallStatus(): "ok" | "error" | "pending" {
  const statuses = Object.values(store.providerStatus);
  if (statuses.every((s) => s.status === "pending")) return "pending";
  if (statuses.some((s) => s.status === "ok")) return "ok";
  return "error";
}

// Matching statistics
export function getMatchingStats() {
  const events = Array.from(store.events.values());
  const matched = events.filter((e) => Object.keys(e.providers).length > 1);
  return {
    rawTotal: root.rawEventCount,
    matchedCount: matched.length,
    unmatchedCount: events.length - matched.length,
    storedTotal: events.length,
  };
}

// Sync Status
export function setSyncStatus(status: Partial<SyncStatus>): void {
  Object.assign(syncStatus, status);
}

export function getSyncStatus(): SyncStatus {
  return { ...syncStatus };
}

// ============================================
// Unmatch Capability (Phase 3: Self-Correcting)
// ============================================

/**
 * Get matched events for AI verification
 * Returns events that have 2+ providers matched
 */
export function getMatchedEventsForVerification(
  options: {
    limit?: number;
    offset?: number;
    excludeVerified?: Set<string>; // Event IDs already verified this session
  } = {},
): NormalizedEvent[] {
  let events = Array.from(store.events.values()).filter(
    (e) => Object.keys(e.providers).length > 1,
  );

  // Exclude already-verified events
  if (options.excludeVerified) {
    events = events.filter((e) => !options.excludeVerified!.has(e.id));
  }

  // Sort by number of providers (more providers = higher priority to verify)
  events.sort(
    (a, b) => Object.keys(b.providers).length - Object.keys(a.providers).length,
  );

  // Apply pagination
  const offset = options.offset || 0;
  const limit = options.limit || 50;
  return events.slice(offset, offset + limit);
}

/**
 * Unmatch an event - separate providers back into individual events
 * Returns the newly created separate events
 */
export function unmatchEvent(
  eventId: string,
  options: {
    keepProvidersMatched?: ProviderKey[]; // Providers to keep matched (if any)
    reason?: string;
  } = {},
): {
  success: boolean;
  message: string;
  separatedEvents?: NormalizedEvent[];
  remainingEvent?: NormalizedEvent;
} {
  const event = store.events.get(eventId);
  if (!event) {
    return { success: false, message: "Event not found" };
  }

  const providerKeys = Object.keys(event.providers) as ProviderKey[];
  if (providerKeys.length < 2) {
    return {
      success: false,
      message: "Event has only one provider, cannot unmatch",
    };
  }

  const keepMatched = new Set(options.keepProvidersMatched || []);
  const separatedEvents: NormalizedEvent[] = [];

  // Determine which providers to separate
  const toSeparate = providerKeys.filter((p) => !keepMatched.has(p));
  const toKeep = providerKeys.filter((p) => keepMatched.has(p));

  // If nothing to separate, return error
  if (toSeparate.length === 0) {
    return { success: false, message: "No providers to separate" };
  }

  // If keeping some matched, update the original event
  let remainingEvent: NormalizedEvent | undefined;
  if (toKeep.length > 0) {
    // Keep the original event with only the specified providers
    const newProviders: NormalizedEvent["providers"] = {};
    for (const p of toKeep) {
      const pd = event.providers[p];
      if (pd) {
        newProviders[p] = pd;
      }
    }

    remainingEvent = {
      ...event,
      providers: newProviders,
    };
    store.events.set(eventId, remainingEvent);
  } else {
    // Remove the original event entirely
    store.events.delete(eventId);
  }

  // Create separate events for each provider being separated
  for (const providerKey of toSeparate) {
    const providerData = event.providers[providerKey];
    if (!providerData) continue;

    const newId = `${providerKey}-${providerData.eventId}`;

    // Check if this event already exists as separate
    const existing = store.events.get(newId);
    if (existing) {
      // Event already exists separately, skip
      continue;
    }

    const newEvent: NormalizedEvent = {
      id: newId,
      sport: event.sport,
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      competition: event.competition,
      startTime: event.startTime,
      providers: {
        [providerKey]: providerData,
      },
    };

    store.events.set(newId, newEvent);
    separatedEvents.push(newEvent);
  }

  // Invalidate cache
  root.cachedStats = null;
  store.lastUpdate = new Date();

  return {
    success: true,
    message: `Unmatched ${toSeparate.length} provider(s) from event`,
    separatedEvents,
    remainingEvent,
  };
}

/**
 * Force unmatch all providers - completely dissolve the match
 */
export function unmatchEventCompletely(eventId: string): {
  success: boolean;
  message: string;
  separatedEvents?: NormalizedEvent[];
} {
  return unmatchEvent(eventId, { keepProvidersMatched: [] });
}

/**
 * Get event details for verification display
 */
export function getEventDetailsForVerification(eventId: string): {
  event: NormalizedEvent | null;
  providerDetails: Array<{
    provider: ProviderKey;
    providerId: string;
    homeTeam: string;
    awayTeam: string;
    competition: string;
    startTime: Date;
  }>;
} | null {
  const event = store.events.get(eventId);
  if (!event) return null;

  const providerDetails = (Object.keys(event.providers) as ProviderKey[])
    .filter((provider) => event.providers[provider])
    .map((provider) => ({
      provider,
      providerId: event.providers[provider]!.eventId,
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      competition: event.competition,
      startTime: event.startTime,
    }));

  return { event, providerDetails };
}
