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
