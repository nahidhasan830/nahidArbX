import type { NormalizedEvent } from "./types";
import type { ValueBet } from "./atoms/types";
import { PROVIDER_REGISTRY, type ProviderKey } from "./providers/registry";

type Provider = ProviderKey;

export interface ProviderStatus {
  status: "ok" | "error" | "pending";
  lastFetch: Date | null;
  error?: string;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  unhealthySinceAt: Date | null;
  consecutiveFailures: number;
  lastError?: string;
}

export type ProviderStatusUpdate = Pick<ProviderStatus, "status"> &
  Partial<Omit<ProviderStatus, "status">>;

export type SyncPhase = "idle" | "fixtures" | "matching" | "markets";
export type MarketsSubPhase = ProviderKey;

export interface PhaseProgress {
  current: number;
  total: number;
  subPhase?: MarketsSubPhase;
}

export interface SyncStatus {
  isSchedulerActive: boolean;
  isSyncing: boolean;
  lastSyncStart: Date | null;
  lastSyncEnd: Date | null;
  firstSyncCompletedAt: Date | null;
  syncInterval: number;
  lastSyncDuration: number | null;
  lastMarketsCount: number;
  currentPhase: SyncPhase;
  phaseProgress: PhaseProgress | null;
}

interface Store {
  events: Map<string, NormalizedEvent>;
  valueBets: ValueBet[];
  providerStatus: Record<Provider, ProviderStatus>;
  lastUpdate: Date | null;
}

function initializeProviderStatus(): Record<Provider, ProviderStatus> {
  const status = {} as Record<Provider, ProviderStatus>;
  for (const id of Object.keys(PROVIDER_REGISTRY) as Provider[]) {
    status[id] = {
      status: "pending",
      lastFetch: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      unhealthySinceAt: null,
      consecutiveFailures: 0,
    };
  }
  return status;
}

function emptyProviderStatus(): ProviderStatus {
  return {
    status: "pending",
    lastFetch: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    unhealthySinceAt: null,
    consecutiveFailures: 0,
  };
}

function normalizeProviderStatus(status: ProviderStatusUpdate): ProviderStatus {
  const lastAttemptAt = status.lastAttemptAt ?? status.lastFetch ?? null;
  const lastSuccessAt =
    status.lastSuccessAt ??
    (status.status === "ok" ? (status.lastFetch ?? lastAttemptAt) : null);
  const lastError =
    status.lastError ?? (status.status === "error" ? status.error : undefined);
  const lastErrorAt =
    status.lastErrorAt ??
    (status.status === "error" ? (status.lastFetch ?? lastAttemptAt) : null);
  const unhealthySinceAt =
    status.status === "error"
      ? (status.unhealthySinceAt ?? lastErrorAt ?? lastAttemptAt)
      : null;

  return {
    status: status.status,
    lastFetch: status.lastFetch ?? lastAttemptAt,
    error: status.status === "error" ? status.error : undefined,
    lastAttemptAt,
    lastSuccessAt,
    lastErrorAt,
    unhealthySinceAt,
    consecutiveFailures:
      status.consecutiveFailures ?? (status.status === "error" ? 1 : 0),
    lastError,
  };
}

function ensureProviderStatus(provider: Provider): ProviderStatus {
  const existing = store.providerStatus[provider];
  const normalized = normalizeProviderStatus(existing ?? emptyProviderStatus());
  store.providerStatus[provider] = normalized;
  return normalized;
}

interface CachedStats {
  providerCounts: Record<string, number>;
  matchedCount: number;
  totalEvents: number;
}

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
      firstSyncCompletedAt: null,
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

const syncStatus: SyncStatus = root.syncStatus;

export function getEvent(eventId: string): NormalizedEvent | undefined {
  return store.events.get(eventId);
}

export function setEvents(events: NormalizedEvent[], rawCount?: number): void {
  const newEventIds = new Set(events.map((e) => e.id));

  const existingIds = Array.from(store.events.keys());
  for (const id of existingIds) {
    if (!newEventIds.has(id)) {
      store.events.delete(id);
    }
  }

  for (const event of events) {
    store.events.set(event.id, event);
  }

  store.lastUpdate = new Date();
  root.cachedStats = null;
  if (rawCount !== undefined) {
    root.rawEventCount = rawCount;
  }
}

export function getEvents(): NormalizedEvent[] {
  return Array.from(store.events.values());
}

export function getMatchedEvents(): NormalizedEvent[] {
  return Array.from(store.events.values()).filter(
    (e) => Object.keys(e.providers).length > 1,
  );
}

export function setValueBets(vbs: ValueBet[]): void {
  store.valueBets = [...vbs].sort((a, b) => b.evPct - a.evPct);
  store.lastUpdate = new Date();
  root.cachedStats = null;
}

export function getValueBets(): ValueBet[] {
  return store.valueBets;
}

export function getValueBetsByEvent(): Map<string, ValueBet[]> {
  const grouped = new Map<string, ValueBet[]>();
  for (const vb of store.valueBets) {
    const list = grouped.get(vb.eventId) || [];
    list.push(vb);
    grouped.set(vb.eventId, list);
  }
  return grouped;
}

export function setProviderStatus(
  provider: Provider,
  status: ProviderStatusUpdate,
): void {
  const prev = ensureProviderStatus(provider);
  const now = new Date();
  const lastAttemptAt = status.lastAttemptAt ?? status.lastFetch ?? now;
  const lastSuccessAt =
    status.status === "ok"
      ? (status.lastSuccessAt ?? status.lastFetch ?? lastAttemptAt)
      : (status.lastSuccessAt ?? prev?.lastSuccessAt ?? null);
  const lastErrorAt =
    status.status === "error"
      ? (status.lastErrorAt ?? status.lastFetch ?? lastAttemptAt)
      : (status.lastErrorAt ?? prev?.lastErrorAt ?? null);
  const lastError =
    status.status === "error"
      ? (status.lastError ?? status.error ?? prev?.lastError)
      : undefined;
  const unhealthySinceAt =
    status.status === "error"
      ? (status.unhealthySinceAt ??
        prev.unhealthySinceAt ??
        lastErrorAt ??
        lastAttemptAt)
      : null;

  store.providerStatus[provider] = {
    ...status,
    lastFetch: status.lastFetch ?? lastAttemptAt,
    error: status.status === "error" ? status.error : undefined,
    lastAttemptAt,
    lastSuccessAt,
    lastErrorAt,
    unhealthySinceAt,
    consecutiveFailures:
      status.status === "error"
        ? (status.consecutiveFailures ?? prev.consecutiveFailures + 1)
        : (status.consecutiveFailures ?? 0),
    lastError,
  };
}

export function markProviderAttempt(provider: Provider, at = new Date()): void {
  const prev = ensureProviderStatus(provider);
  store.providerStatus[provider] = {
    ...prev,
    lastAttemptAt: at,
  };
}

export function getProviderStatus(provider: Provider): ProviderStatus {
  return ensureProviderStatus(provider);
}

export function getAllProviderStatus(): Record<Provider, ProviderStatus> {
  for (const id of Object.keys(PROVIDER_REGISTRY) as Provider[]) {
    ensureProviderStatus(id);
  }
  return store.providerStatus;
}

export function getLastUpdate(): Date | null {
  return store.lastUpdate;
}

export function getOverallStatus(): "ok" | "error" | "pending" {
  const statuses = Object.values(store.providerStatus);
  if (statuses.every((s) => s.status === "pending")) return "pending";
  if (statuses.some((s) => s.status === "ok")) return "ok";
  return "error";
}

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

export function setSyncStatus(status: Partial<SyncStatus>): void {
  if (status.lastSyncEnd && !syncStatus.firstSyncCompletedAt) {
    status.firstSyncCompletedAt = status.lastSyncEnd;
  }
  Object.assign(syncStatus, status);
}

export function getSyncStatus(): SyncStatus {
  return { ...syncStatus };
}
