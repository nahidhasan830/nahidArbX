/**
 * Atoms Unified Odds Fetcher
 *
 * Orchestrates parallel odds fetching from all providers
 * and stores directly into the atoms store.
 */

import pLimit from "p-limit";
import { getEnabledAtomsAdapters } from "./adapters/registry";
import { fetchAndStorePinnacleOdds } from "./adapters/pinnacle";
import {
  beginFetchCycle,
  endFetchCycleCleanup,
  clearOddsForEvent,
} from "./store";
import { type ProviderKey, PROVIDER_REGISTRY } from "../providers/registry";
import { getProviderPolicy } from "../shared/circuit-breaker";
import type { NormalizedEvent } from "../types";

// ============================================
// Per-Provider Concurrency Limiters
// ============================================

// Adaptive concurrency per provider (no rate limits on providers)
const PROVIDER_CONCURRENCY: Partial<Record<ProviderKey, number>> = {
  pinnacle: 25,
  betconstruct: 50,
  "ninewickets-exchange": 30,
  "ninewickets-sportsbook": 30,
};

const DEFAULT_CONCURRENCY = 20;

// Reusable p-limit instances per provider
const providerLimiters = new Map<string, ReturnType<typeof pLimit>>();

function getProviderLimiter(providerId: string): ReturnType<typeof pLimit> {
  let limiter = providerLimiters.get(providerId);
  if (!limiter) {
    const concurrency =
      PROVIDER_CONCURRENCY[providerId as ProviderKey] ?? DEFAULT_CONCURRENCY;
    limiter = pLimit(concurrency);
    providerLimiters.set(providerId, limiter);
  }
  return limiter;
}

// ============================================
// Types
// ============================================

export interface FetchOptions {
  onProgress?: (phase: FetchPhase, current: number, total: number) => void;
}

// FetchPhase is now derived from registry
export type FetchPhase = ProviderKey;

// Provider-level stats
export interface ProviderStats {
  events: number;
  odds: number;
  errors: number;
}

// Dynamic fetch stats using provider IDs
export interface FetchStats {
  byProvider: Record<string, ProviderStats>;
  totalOdds: number;
  durationMs: number;
}

// Single event fetch result with per-provider breakdown
export interface SingleEventFetchResult {
  totalOdds: number;
  byProvider: Record<string, number>; // e.g. { pinnacle: 56, "ninewickets-exchange": 5 }
}

// ============================================
// Core Fetcher
// ============================================

/**
 * Fetch all odds for matched events and store in atoms store.
 *
 *
 * Flow:
 * 1. Begin fetch cycle (tracks which entries are refreshed)
 * 2. For each enabled provider adapter:
 *    - Filter events for this provider
 *    - Fetch odds in parallel batches (overwrites existing entries)
 * 3. Clean up stale entries not refreshed in this cycle
 *
 * @param events - Matched events with provider info
 * @param options - Fetch options
 * @returns Fetch statistics
 */
export async function fetchAllOddsForMatchedEvents(
  events: NormalizedEvent[],
  options: FetchOptions = {},
): Promise<FetchStats> {
  const { onProgress } = options;
  const startTime = Date.now();

  // Initialize stats dynamically
  const stats: FetchStats = {
    byProvider: {},
    totalOdds: 0,
    durationMs: 0,
  };

  // Initialize stats for all providers in registry
  for (const id of Object.keys(PROVIDER_REGISTRY)) {
    stats.byProvider[id] = { events: 0, odds: 0, errors: 0 };
  }

  // Start fetch cycle — tracks which entries are refreshed so stale ones can be cleaned up after
  beginFetchCycle();

  // Get all enabled adapters
  const enabledAdapters = getEnabledAtomsAdapters();

  // Process all providers in PARALLEL (not sequentially!)
  await Promise.all(
    enabledAdapters.map(async (adapter) => {
      const providerId = adapter.providerId;
      const providerEvents = events.filter((e) => e.providers[providerId]);

      if (providerEvents.length === 0) return;

      await fetchProviderOdds(
        providerEvents,
        async (event) => {
          const providerEventId = event.providers[providerId]!.eventId;
          return adapter.fetchAndStoreOdds(
            providerEventId,
            event.id,
            event.homeTeam,
            event.awayTeam,
          );
        },
        stats.byProvider[providerId],
        providerId,
        (current, total) => onProgress?.(providerId, current, total),
      );
    }),
  );

  // Calculate totals
  stats.totalOdds = Object.values(stats.byProvider).reduce(
    (sum, p) => sum + p.odds,
    0,
  );
  stats.durationMs = Date.now() - startTime;

  // Clean up stale entries not refreshed in this cycle
  endFetchCycleCleanup(events.map((e) => e.id));

  return stats;
}

// ============================================
// Helpers
// ============================================

/**
 * Fetch odds from a provider using p-limit for optimal concurrency.
 * Unlike batching, p-limit keeps exactly N requests in-flight at all times
 * (no idle gaps between batches).
 */
async function fetchProviderOdds(
  events: NormalizedEvent[],
  fetchFn: (event: NormalizedEvent) => Promise<number>,
  stats: ProviderStats,
  providerId: string,
  onProgress?: (current: number, total: number) => void,
): Promise<void> {
  const limiter = getProviderLimiter(providerId);
  let processed = 0;

  const policy = getProviderPolicy(providerId);

  const tasks = events.map((event) =>
    limiter(async () => {
      try {
        const count = await policy.execute(() => fetchFn(event));
        stats.events++;
        stats.odds += count;
      } catch {
        stats.errors++;
      }
      processed++;
      onProgress?.(processed, events.length);
    }),
  );

  await Promise.all(tasks);
}

/**
 * Quick fetch for a single event (used for live updates).
 * Uses fast mode for Pinnacle to skip slow token capture if expired.
 *
 * @param event - Single event to fetch
 * @returns Fetch result with total odds and per-provider breakdown
 */
export async function fetchOddsForSingleEvent(
  event: NormalizedEvent,
): Promise<SingleEventFetchResult> {
  // Clear existing odds to prevent stale data when outcomes become suspended
  clearOddsForEvent(event.id);

  const byProvider: Record<string, number> = {};
  const providerIds: string[] = [];
  const tasks: Promise<number>[] = [];

  // Dynamically check each enabled adapter
  for (const adapter of getEnabledAtomsAdapters()) {
    const providerId = adapter.providerId;
    if (event.providers[providerId]) {
      const providerEventId = event.providers[providerId]!.eventId;
      providerIds.push(providerId);

      // Use fast mode for Pinnacle to skip slow token capture
      if (providerId === "pinnacle") {
        tasks.push(
          fetchAndStorePinnacleOdds(
            providerEventId,
            event.id,
            event.homeTeam,
            event.awayTeam,
            { fastMode: true },
          ),
        );
      } else {
        tasks.push(
          adapter.fetchAndStoreOdds(
            providerEventId,
            event.id,
            event.homeTeam,
            event.awayTeam,
          ),
        );
      }
    }
  }

  const results = await Promise.allSettled(tasks);

  // Map results back to provider IDs
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const providerId = providerIds[i];
    byProvider[providerId] = result.status === "fulfilled" ? result.value : -1; // -1 = failed
  }

  // Calculate total (excluding failures)
  const totalOdds = Object.values(byProvider)
    .filter((v) => v > 0)
    .reduce((a, b) => a + b, 0);

  return { totalOdds, byProvider };
}
