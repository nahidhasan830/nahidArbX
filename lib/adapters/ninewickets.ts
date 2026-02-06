import axios, { isAxiosError } from "axios";
import { z } from "zod";
import type {
  ProviderAdapter,
  NormalizedEvent,
  NormalizedMarket,
} from "../types";

// Nine Wickets API Response Schemas
const NineWicketsPriceSchema = z.object({
  price: z.number(),
  size: z.number(),
});

const NineWicketsSelectionSchema = z.object({
  selectionId: z.number(),
  runnerName: z.string(),
  sortPriority: z.number(), // 1=home, 2=away, 3=draw
  status: z.number(),
  availableToBack: z.array(NineWicketsPriceSchema).optional(),
  availableToLay: z.array(NineWicketsPriceSchema).optional(),
});

const NineWicketsMarketSchema = z.object({
  eventId: z.number(),
  marketId: z.string(),
  marketType: z.string(),
  marketName: z.string(),
  status: z.number(),
  selections: z.array(NineWicketsSelectionSchema).optional(),
});

const NineWicketsEventSchema = z.object({
  eventId: z.number(),
  eventName: z.string(),
  competitionId: z.number(),
  competitionName: z.string(),
  openDateTime: z.number(), // timestamp in ms
  eventType: z.number(),
  status: z.number(),
  market: NineWicketsMarketSchema.optional(),
});

const NineWicketsResponseSchema = z.object({
  events: z.array(NineWicketsEventSchema),
});

type NineWicketsEvent = z.infer<typeof NineWicketsEventSchema>;
type NineWicketsSelection = z.infer<typeof NineWicketsSelectionSchema>;

const BASE_URL = "https://gakvx.seofmi.live";
const ENDPOINT = "/exchange/member/playerService/queryEvents";

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  },
});

function parseTeamNames(eventName: string): { home: string; away: string } {
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
    id: `ninewickets-${event.eventId}`,
    sport: "football",
    homeTeam: home,
    awayTeam: away,
    competition: event.competitionName,
    startTime: new Date(event.openDateTime),
    providers: {
      ninewickets: {
        eventId: String(event.eventId),
        fetchedAt: new Date(),
      },
    },
  };
}

function getOutcomeLabel(sortPriority: number): string {
  switch (sortPriority) {
    case 1:
      return "home";
    case 2:
      return "away";
    case 3:
      return "draw";
    default:
      return "unknown";
  }
}

function transformMarket(event: NineWicketsEvent): NormalizedMarket | null {
  const market = event.market;
  if (!market || !market.selections || market.marketType !== "MATCH_ODDS") {
    return null;
  }

  const outcomes: { label: string; odds: number; provider: "ninewickets" }[] =
    [];

  for (const selection of market.selections) {
    // Get best back price
    const backPrices = selection.availableToBack;
    if (!backPrices || backPrices.length === 0) {
      continue;
    }

    const bestBackOdds = backPrices[0].price;
    if (bestBackOdds <= 1) {
      continue; // Invalid odds
    }

    outcomes.push({
      label: getOutcomeLabel(selection.sortPriority),
      odds: bestBackOdds,
      provider: "ninewickets",
    });
  }

  // Need at least 2 outcomes for a valid market
  if (outcomes.length < 2) {
    return null;
  }

  return {
    eventId: `ninewickets-${event.eventId}`,
    type: "match_winner",
    outcomes,
  };
}

function formatError(error: unknown): string {
  if (isAxiosError(error)) {
    if (error.response) {
      const { status, statusText, data } = error.response;
      return `${status} ${statusText}${data ? ` - ${JSON.stringify(data)}` : ""}`;
    }
    // Network error or no response
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

async function fetchEventsForType(
  type: number
): Promise<{ events: NormalizedEvent[]; markets: NormalizedMarket[] }> {
  const events: NormalizedEvent[] = [];
  const markets: NormalizedMarket[] = [];

  try {
    const params = new URLSearchParams({
      type: String(type),
      eventType: "1", // Football
      competitionTs: "-1",
      eventTs: "-1",
      marketTs: "-1",
      selectionTs: "-1",
      collectEventIds: "",
    });

    const response = await client.post(ENDPOINT, params.toString());

    const parsed = NineWicketsResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      console.error(
        `[NineWickets] Invalid response for type=${type}:`,
        parsed.error.message
      );
      return { events, markets };
    }

    for (const rawEvent of parsed.data.events) {
      const event = transformEvent(rawEvent);
      if (event) {
        events.push(event);
      }

      const market = transformMarket(rawEvent);
      if (market) {
        markets.push(market);
      }
    }
  } catch (error) {
    console.warn(`[NineWickets] fetchEvents type=${type} error:`, formatError(error));
  }

  return { events, markets };
}

// Store markets in memory for fetchMarkets calls
const marketsCache = new Map<string, NormalizedMarket>();

export const ninewicketsAdapter: ProviderAdapter = {
  name: "ninewickets",

  async fetchEvents(): Promise<NormalizedEvent[]> {
    // Fetch both live (type=1) and upcoming (type=6) in parallel
    const [liveResult, upcomingResult] = await Promise.all([
      fetchEventsForType(1),
      fetchEventsForType(6),
    ]);

    // Combine and dedupe by eventId
    const eventsMap = new Map<string, NormalizedEvent>();

    for (const event of [...liveResult.events, ...upcomingResult.events]) {
      eventsMap.set(event.id, event);
    }

    // Update markets cache
    marketsCache.clear();
    for (const market of [...liveResult.markets, ...upcomingResult.markets]) {
      marketsCache.set(market.eventId, market);
    }

    console.log(
      `[NineWickets] Fetched ${eventsMap.size} events, ${marketsCache.size} markets`
    );

    return Array.from(eventsMap.values());
  },

  async fetchMarkets(eventId: string): Promise<NormalizedMarket[]> {
    // Markets are already fetched with events, return from cache
    const market = marketsCache.get(eventId);
    return market ? [market] : [];
  },
};
