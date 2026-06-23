
import type { ProviderAdapter, NormalizedEvent, Provider } from "../types";
import {
  ninewicketsExchangeAdapter,
  debugFetchNinewicketsExchangeEvents,
} from "./ninewickets-exchange";
import type { DebugFixturesFetchResult } from "./debug-fetch";


const PROVIDER_NAME: Provider = "ninewickets-sportsbook";


export const ninewicketsSportsbookAdapter: ProviderAdapter = {
  name: PROVIDER_NAME,

  async fetchEvents(): Promise<NormalizedEvent[]> {
    const exchangeEvents = await ninewicketsExchangeAdapter.fetchEvents();

    const sportsbookEvents = exchangeEvents.map((event) => {
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


export async function debugFetchNinewicketsSportsbookEvents(): Promise<DebugFixturesFetchResult> {
  const exchangeResult = await debugFetchNinewicketsExchangeEvents();

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
