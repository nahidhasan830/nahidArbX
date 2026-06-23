
import { getEnabledAtomsAdapters } from "./adapters/registry";
import { clearOddsForEvent } from "./store";

import type { NormalizedEvent } from "../types";

export interface SingleEventFetchResult {
  totalOdds: number;
  byProvider: Record<string, number>;
}

export async function fetchOddsForSingleEvent(
  event: NormalizedEvent,
): Promise<SingleEventFetchResult> {
  clearOddsForEvent(event.id);

  const byProvider: Record<string, number> = {};
  const providerIds: string[] = [];
  const tasks: Promise<number>[] = [];

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

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const providerId = providerIds[i];
    byProvider[providerId] = result.status === "fulfilled" ? result.value : -1;
  }

  const totalOdds = Object.values(byProvider)
    .filter((v) => v > 0)
    .reduce((a, b) => a + b, 0);

  return { totalOdds, byProvider };
}
