/**
 * NineWickets Sportsbook Adapter
 *
 * Event adapter that delegates to Exchange adapter (same eventId).
 * Sportsbook markets are fetched via atoms adapter using 2-step API flow.
 *
 * This adapter only handles event fetching - it reuses Exchange fixtures
 * and re-tags them with the sportsbook provider ID.
 */

import type { ProviderAdapter, NormalizedEvent, Provider } from "../types";
import {
  ninewicketsExchangeAdapter,
  debugFetchNinewicketsExchangeEvents,
} from "./ninewickets-exchange";
import type { DebugFixturesFetchResult } from "./debug-fetch";

// ============================================
// Constants
// ============================================

const PROVIDER_NAME: Provider = "ninewickets-sportsbook";

// ============================================
// Provider Adapter
// ============================================

export const ninewicketsSportsbookAdapter: ProviderAdapter = {
  name: PROVIDER_NAME,

  async fetchEvents(): Promise<NormalizedEvent[]> {
    // Delegate to Exchange adapter - same fixtures API, same eventIds
    const exchangeEvents = await ninewicketsExchangeAdapter.fetchEvents();

    // Re-tag events with sportsbook provider (preserving same eventId)
    const sportsbookEvents = exchangeEvents.map((event) => {
      // Extract the raw eventId from Exchange event
      const exchangeProviderData = event.providers["ninewickets-exchange"];
      if (!exchangeProviderData) {
        return null;
      }

      const rawEventId = exchangeProviderData.eventId;

      return {
        ...event,
        id: `ninewickets-sportsbook-${rawEventId}`,
        providers: {
          "ninewickets-sportsbook": {
            eventId: rawEventId,
            fetchedAt: new Date(),
          },
        },
      } as NormalizedEvent;
    });

    const validEvents = sportsbookEvents.filter(
      (e): e is NormalizedEvent => e !== null,
    );

    return validEvents;
  },
};

// ============================================
// Debug Fetch (for debug pipeline)
// ============================================

export async function debugFetchNinewicketsSportsbookEvents(): Promise<DebugFixturesFetchResult> {
  // Delegate to Exchange debug fetch
  const exchangeResult = await debugFetchNinewicketsExchangeEvents();

  // Re-tag events for sportsbook
  const sportsbookEvents = exchangeResult.normalizedEvents
    .map((event) => {
      const exchangeData = event.providers["ninewickets-exchange"];
      if (!exchangeData) return null;

      return {
        ...event,
        id: `ninewickets-sportsbook-${exchangeData.eventId}`,
        providers: {
          "ninewickets-sportsbook": {
            eventId: exchangeData.eventId,
            fetchedAt: new Date(),
          },
        },
      } as NormalizedEvent;
    })
    .filter((e): e is NormalizedEvent => e !== null);

  return {
    provider: "ninewickets-sportsbook",
    providerRequests: exchangeResult.providerRequests.map((req) => ({
      ...req,
      label: req.label ? `${req.label} (via Exchange)` : "(via Exchange)",
    })),
    rawResponses: exchangeResult.rawResponses,
    normalizedEvents: sportsbookEvents,
    eventCount: sportsbookEvents.length,
  };
}
