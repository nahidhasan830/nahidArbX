import type { Provider, NormalizedEvent, Arbitrage } from "./types";

export interface ProviderStatus {
  status: "ok" | "error" | "pending";
  lastFetch: Date | null;
  error?: string;
}

interface Store {
  events: Map<string, NormalizedEvent>;
  arbitrages: Arbitrage[];
  providerStatus: Record<Provider, ProviderStatus>;
  lastUpdate: Date | null;
}

const store: Store = {
  events: new Map(),
  arbitrages: [],
  providerStatus: {
    pslive: { status: "pending", lastFetch: null },
    ninewickets: { status: "pending", lastFetch: null },
  },
  lastUpdate: null,
};

// Track raw event count before matching
let rawEventCount = 0;

// Events
export function setEvents(events: NormalizedEvent[], rawCount?: number): void {
  store.events.clear();
  events.forEach((event) => store.events.set(event.id, event));
  if (rawCount !== undefined) {
    rawEventCount = rawCount;
  }
}

export function getEvents(): NormalizedEvent[] {
  return Array.from(store.events.values());
}

// Arbitrages
export function setArbitrages(arbs: Arbitrage[]): void {
  store.arbitrages = arbs;
  store.lastUpdate = new Date();
}

export function getArbitrages(): Arbitrage[] {
  return store.arbitrages;
}

// Provider Status
export function setProviderStatus(
  provider: Provider,
  status: ProviderStatus
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
    rawTotal: rawEventCount,
    matchedCount: matched.length,
    unmatchedCount: events.length - matched.length,
    storedTotal: events.length,
  };
}
