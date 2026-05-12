/**
 * Atoms Single-Event Odds Fetcher
 *
 * Provides on-demand odds refresh for a single event (UI refresh button).
 * Batch odds fetching has been removed — odds flow in real-time from
 * PinnacleSyncService (WebSocket) and GeniusSportsSyncService (continuous polling).
 */

import { getEnabledAtomsAdapters } from "./adapters/registry";
import { clearOddsForEvent } from "./store";

import type { NormalizedEvent } from "../types";

/** Result for a single-event refresh request. */
export interface SingleEventFetchResult {
  totalOdds: number;
  byProvider: Record<string, number>;
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

  // Single-event refreshes always run in fast mode: any adapter that does slow
  // setup work (e.g. Pinnacle's interactive token capture) should bail rather
  // than block the live UI. Adapters ignore the flag if it doesn't apply.
  const liveOptions = { fastMode: true };

  for (const adapter of getEnabledAtomsAdapters()) {
    const providerId = adapter.providerId;
    if (event.providers[providerId]) {
      const providerEventId = event.providers[providerId]!.eventId;
      providerIds.push(providerId);
      tasks.push(
        adapter.fetchAndStoreOdds(
          providerEventId,
          event.id,
          event.homeTeam,
          event.awayTeam,
          liveOptions,
        ),
      );
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
