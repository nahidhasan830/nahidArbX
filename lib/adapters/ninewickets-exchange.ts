/**
 * NineWickets Exchange Adapter
 *
 * Fetches events and markets from the NineWickets Exchange API.
 * Exchange offers 4 markets: MATCH_ODDS, OVER_UNDER_05, OVER_UNDER_15, OVER_UNDER_25
 *
 * API Flow:
 * 1. Fetch events: POST gakvx.seofmi.live/exchange/member/playerService/queryEvents
 * 2. Fetch markets: POST awskvx.seofmi.live/exchange/member/playerService/queryMarkets
 */

import type { ProviderAdapter, NormalizedEvent, Provider } from "../types";
import { formatError } from "../shared/errors";
import { validateAndParse } from "../shared/validation";
import { createProviderClient } from "../shared/http";
import { deduplicateById } from "../shared/deduplication";
import { logger } from "../shared/logger";
import type {
  DebugFixturesFetchResult,
  DebugHttpRequest,
  DebugHttpResponse,
} from "./debug-fetch";
import { MarketsResponseSchema } from "../shared/schemas/ninewickets";
import {
  NineWicketsEventsResponseSchema,
  type NineWicketsEvent,
} from "../shared/schemas/ninewickets-events";
import { mapExchangeToAtom } from "../atoms/mappings/ninewickets-exchange";

// ============================================
// Constants
// ============================================

const PROVIDER_NAME: Provider = "ninewickets-exchange";

// API Endpoints
const FIXTURES_BASE_URL = "https://gakvx.seofmi.live";
const MARKETS_BASE_URL = "https://awskvx.seofmi.live";
const EVENTS_ENDPOINT = "/exchange/member/playerService/queryEvents";
const MARKETS_ENDPOINT = "/exchange/member/playerService/queryMarkets";

// ============================================
// Axios Clients
// ============================================

const eventsClient = createProviderClient({
  baseURL: FIXTURES_BASE_URL,
  contentType: "form-urlencoded",
});

const marketsClient = createProviderClient({
  baseURL: MARKETS_BASE_URL,
  contentType: "form-urlencoded",
});

// ============================================
// URL Params Helpers
// ============================================

/** Default parameters for event queries */
const DEFAULT_EVENT_PARAMS = {
  eventType: "1", // Football
  competitionTs: "-1",
  eventTs: "-1",
  marketTs: "-1",
  selectionTs: "-1",
  collectEventIds: "",
};

function buildEventParams(type: number): URLSearchParams {
  return new URLSearchParams({
    type: String(type),
    ...DEFAULT_EVENT_PARAMS,
  });
}

// Re-export schemas and types for backward compatibility
export {
  NineWicketsEventSchema,
  NineWicketsEventsResponseSchema,
  type NineWicketsEvent,
} from "../shared/schemas/ninewickets-events";
export { mapExchangeToAtom };

// ============================================
// Normalized Market Type
// ============================================

export interface NormalizedMarket {
  marketType: string;
  atomId: string;
  odds: number;
  timestamp: number;
}

// ============================================
// Helper Functions
// ============================================

export function parseTeamNames(eventName: string): {
  home: string;
  away: string;
} {
  // Format: "Team A v Team B"
  const parts = eventName.split(" v ");
  if (parts.length === 2) {
    return { home: parts[0].trim(), away: parts[1].trim() };
  }
  // Fallback if format is different
  return { home: eventName, away: "" };
}

function transformEvent(event: NineWicketsEvent): NormalizedEvent | null {
  const { home, away } = parseTeamNames(event.eventName);

  // Skip events without proper team names
  if (!home || !away) {
    return null;
  }

  return {
    id: `ninewickets-exchange-${event.eventId}`,
    sport: "football",
    homeTeam: home,
    awayTeam: away,
    competition: event.competitionName,
    startTime: new Date(event.openDateTime),
    providers: {
      "ninewickets-exchange": {
        eventId: String(event.eventId),
        fetchedAt: new Date(),
      },
    },
  };
}

// ============================================
// Event Fetching
// ============================================

async function fetchEventsForType(type: number): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];

  try {
    const params = buildEventParams(type);
    const response = await eventsClient.post(
      EVENTS_ENDPOINT,
      params.toString(),
    );

    const parsed = validateAndParse(
      response.data,
      NineWicketsEventsResponseSchema,
      `[NW Exchange] type=${type}`,
    );
    if (!parsed) return events;

    for (const rawEvent of parsed.events) {
      const event = transformEvent(rawEvent);
      if (event) {
        events.push(event);
      }
    }
  } catch (error) {
    logger.warn(
      "NWExchange",
      `fetchEvents type=${type} error: ${formatError(error)}`,
    );
  }

  return events;
}

// ============================================
// Market Fetching
// ============================================

/**
 * Fetch markets for a single event.
 *
 * @param providerEventId - NineWickets' internal event ID
 * @param homeTeam - Home team name (required for accurate 1X2 mapping)
 * @param awayTeam - Away team name (required for accurate 1X2 mapping)
 * @returns Array of normalized markets with odds
 */
export async function fetchMarkets(
  providerEventId: string,
  homeTeam: string,
  awayTeam: string,
): Promise<NormalizedMarket[]> {
  const markets: NormalizedMarket[] = [];

  try {
    const params = new URLSearchParams({
      eventId: providerEventId,
      selectionTs: "0",
    });

    const response = await marketsClient.post(
      MARKETS_ENDPOINT,
      params.toString(),
    );

    const parsed = validateAndParse(
      response.data,
      MarketsResponseSchema,
      `[NW Exchange] markets`,
    );
    if (!parsed) return markets;

    const timestamp = Date.now();

    for (const market of parsed.markets) {
      if (!market.selections || market.selections.length === 0) continue;

      for (const selection of market.selections) {
        const backPrices = selection.availableToBack;
        if (!backPrices || backPrices.length === 0) continue;

        const odds = backPrices[0].price;
        if (odds <= 1) continue;

        const atomId = mapExchangeToAtom(
          market.marketType,
          selection.runnerName,
          homeTeam,
          awayTeam,
        );

        if (!atomId) continue;

        markets.push({
          marketType: market.marketType,
          atomId,
          odds,
          timestamp,
        });
      }
    }
  } catch {
    // Silently handle per-event fetch errors
  }

  return markets;
}

// ============================================
// Provider Adapter
// ============================================

export const ninewicketsExchangeAdapter: ProviderAdapter = {
  name: PROVIDER_NAME,

  async fetchEvents(): Promise<NormalizedEvent[]> {
    // Fetch both live (type=1) and upcoming (type=6) in parallel
    const [liveResult, upcomingResult] = await Promise.all([
      fetchEventsForType(1),
      fetchEventsForType(6),
    ]);

    // Combine and dedupe by eventId
    const events = deduplicateById([...liveResult, ...upcomingResult]);
    return events;
  },
};

// ============================================
// Debug Fetch (for debug pipeline)
// ============================================

export async function debugFetchNinewicketsExchangeEvents(): Promise<DebugFixturesFetchResult> {
  const result: DebugFixturesFetchResult = {
    provider: "ninewickets-exchange",
    providerRequests: [],
    rawResponses: [],
    normalizedEvents: [],
    eventCount: 0,
  };

  // Fetch both types with debug capture
  for (const type of [1, 6]) {
    const label =
      type === 1 ? "Live Events (type=1)" : "Upcoming Events (type=6)";
    const params = buildEventParams(type);

    const request: DebugHttpRequest = {
      label,
      url: `${FIXTURES_BASE_URL}${EVENTS_ENDPOINT}`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    };
    result.providerRequests.push(request);

    try {
      const startTime = Date.now();
      const response = await eventsClient.post(
        EVENTS_ENDPOINT,
        params.toString(),
      );
      const durationMs = Date.now() - startTime;

      const debugResponse: DebugHttpResponse = {
        status: response.status || 200,
        data: response.data,
        durationMs,
      };
      result.rawResponses.push(debugResponse);

      // Parse events
      const parsed = validateAndParse(
        response.data,
        NineWicketsEventsResponseSchema,
        `[NW Exchange debug] type=${type}`,
      );
      if (parsed) {
        for (const rawEvent of parsed.events) {
          const event = transformEvent(rawEvent);
          if (event) {
            result.normalizedEvents.push(event);
          }
        }
      }
    } catch (error) {
      result.rawResponses.push({
        status: 500,
        data: { error: formatError(error) },
        durationMs: 0,
      });
    }
  }

  // Dedupe by eventId
  result.normalizedEvents = deduplicateById(result.normalizedEvents);
  result.eventCount = result.normalizedEvents.length;

  return result;
}
