import axios from "axios";
import { z } from "zod";
import type {
  ProviderAdapter,
  NormalizedEvent,
  NormalizedMarket,
  MarketType,
  Outcome,
} from "../types";
import { config } from "../config";
import { getPsliveToken, getStoredToken } from "../auth/token-manager";

// Sport ID for Soccer in PSLive
const SOCCER_SPORT_ID = 29;

// Market type mapping from PSLive to our normalized types
const MARKET_TYPE_MAP: Record<string, MarketType | null> = {
  MONEYLINE: "match_winner",
  TOTAL_POINTS: "totals",
  // SPREAD and TEAM_TOTAL_POINTS not supported yet
  SPREAD: null,
  TEAM_TOTAL_POINTS: null,
};

// ============================================================
// Zod Schemas for PSLive Response Validation
// ============================================================

// Outcome: exactly 5 elements [odds, handicap, side, direction, originalOdds]
const OutcomeSchema = z.tuple([
  z.number().nullable(), // odds (can be null in edge cases)
  z.number().nullable(), // handicap
  z.string(), // side: "HOME", "AWAY", "DRAW", ""
  z.string(), // direction: "OVER", "UNDER", ""
  z.number().nullable(), // originalOdds (can be null in edge cases)
]);

// Market: exactly 19 elements
const MarketSchema = z.tuple([
  z.number(), // [0] periodId
  z.number(), // [1] halfIndicator
  z.number(), // [2] marketId
  z.number(), // [3] ???
  z.string(), // [4] marketType
  z.boolean(), // [5] ???
  z.number(), // [6] maxStake?
  z.number(), // [7] ???
  z.number(), // [8] ???
  z.number(), // [9] eventId
  z.string(), // [10] periodType
  z.number(), // [11] score?
  z.array(OutcomeSchema), // [12] outcomes
  z.number(), // [13] handicap
  z.string(), // [14] identifier
  z.string(), // [15] side
  z.string(), // [16] status
  z.string(), // [17] fullIdentifier
  z.number(), // [18] timestamp
]);

// Period: exactly 7 elements
const PeriodSchema = z.tuple([
  z.number(), // [0] periodId
  z.number(), // [1] parentEventId
  z.string(), // [2] startTime
  z.string(), // [3] periodType
  z.boolean(), // [4] hasMarkets
  z.array(MarketSchema), // [5] markets
  z.number(), // [6] ???
]);

// Event: exactly 8 elements
const EventSchema = z.tuple([
  z.number(), // [0] eventId
  z.number(), // [1] parentEventId
  z.string(), // [2] homeTeam
  z.string(), // [3] awayTeam
  z.number(), // [4] ???
  z.array(PeriodSchema), // [5] periods
  z.string(), // [6] ???
  z.array(z.unknown()), // [7] periodSummaries
]);

// League: exactly 4 elements [leagueId, leagueName, events[], unknownArray[]]
const LeagueSchema = z.tuple([
  z.number(), // leagueId
  z.string(), // leagueName
  z.array(EventSchema), // events
  z.array(z.unknown()), // unknown (always empty in observed data)
]);

// StatusGroup: exactly 2 elements [status, leagues[]]
const StatusGroupSchema = z.tuple([
  z.string(), // status: "LIVE" or "TODAY"
  z.array(LeagueSchema), // leagues
]);

// Sport: exactly 4 elements [sportId, sportName, isActive, statusGroups[]]
const SportSchema = z.tuple([
  z.number(), // sportId
  z.string(), // sportName
  z.boolean(), // isActive
  z.array(StatusGroupSchema), // statusGroups
]);

// Top-level response
const PSLiveResponseSchema = z.object({
  code: z.number(),
  data: z.tuple([
    z.number(), // pageNo
    z.number(), // pageSize
    z.number(), // totalCount
    z.array(SportSchema), // sports
  ]),
  errorCode: z.string(),
  message: z.string(),
  success: z.boolean().optional(), // may or may not be present
});

type PSLiveResponse = z.infer<typeof PSLiveResponseSchema>;
type PSLiveSport = z.infer<typeof SportSchema>;
type PSLiveLeague = z.infer<typeof LeagueSchema>;
type PSLiveEvent = z.infer<typeof EventSchema>;
type PSLivePeriod = z.infer<typeof PeriodSchema>;
type PSLiveMarket = z.infer<typeof MarketSchema>;
type PSLiveOutcome = z.infer<typeof OutcomeSchema>;

// Token management is handled by ../auth/token-manager

// ============================================================
// URL Builder
// ============================================================

function buildEventsUrl(): string {
  const { daysAhead, pageSize } = config.providers.pslive;

  const now = new Date();
  const fromDate = now.toISOString().slice(0, 10) + "T00:00:00";

  // Calculate end date (today + daysAhead)
  const endDate = new Date(now);
  endDate.setDate(endDate.getDate() + daysAhead);
  const toDate = endDate.toISOString().slice(0, 10) + "T23:59:59";

  // Get timezone offset in format like "-04:00"
  const tzOffset = now.getTimezoneOffset();
  const tzSign = tzOffset <= 0 ? "+" : "-";
  const tzHours = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, "0");
  const tzMins = String(Math.abs(tzOffset) % 60).padStart(2, "0");
  const tz = `${tzSign}${tzHours}:${tzMins}`;

  const params = [
    `odds-format/decimal`,
    `view-mode/ASIAN`,
    `sport-id/${SOCCER_SPORT_ID}`,
    `period-type/TODAY`,
    `country-ids/ALL`,
    `league-ids/ALL`,
    `period-id/-1`,
    `market-type/ALL`,
    `tz/${encodeURIComponent(tz)}`,
    `from-date/${fromDate}`,
    `to-date/${toDate}`,
    `sort-by/LEAGUE`,
    `page-no/1`,
    `page-size/${pageSize}`,
    `locale/en-US`,
  ].join("/");

  return `/proteus-member-service/after-login/odds/v3/events/${params}?keySearch=`;
}

// ============================================================
// Axios Client (no interceptor - we handle auth in fetchEvents for retry logic)
// ============================================================

const client = axios.create({
  baseURL: config.providers.pslive.baseUrl,
  timeout: 30000,
  headers: {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.5",
  },
});

// ============================================================
// Parser Functions
// ============================================================

function parseOutcome(
  outcome: PSLiveOutcome,
  marketType: string
): { label: string; odds: number } | null {
  const [odds, , side, direction] = outcome;

  // Skip null or invalid odds
  if (odds === null || odds <= 1) return null;

  // For MONEYLINE: use side (HOME, AWAY, DRAW)
  if (marketType === "MONEYLINE") {
    const label = side.toLowerCase();
    if (!["home", "away", "draw"].includes(label)) return null;
    return { label, odds };
  }

  // For TOTAL_POINTS: use direction (OVER, UNDER)
  if (marketType === "TOTAL_POINTS") {
    const label = direction.toLowerCase();
    if (!["over", "under"].includes(label)) return null;
    return { label, odds };
  }

  return null;
}

function parseMarket(
  market: PSLiveMarket,
  eventId: string
): NormalizedMarket | null {
  const marketType = market[4]; // "MONEYLINE", "TOTAL_POINTS", etc.
  const periodType = market[10]; // "Regular", "Corners", etc.
  const rawOutcomes = market[12]; // outcomes array
  const handicap = market[13]; // line value
  const status = market[16]; // "OPEN"

  // Skip non-open markets
  if (status !== "OPEN") return null;

  // Map to our market type
  const normalizedType = MARKET_TYPE_MAP[marketType];
  if (!normalizedType) return null;

  // Parse outcomes
  const outcomes: Outcome[] = [];
  for (const rawOutcome of rawOutcomes) {
    const parsed = parseOutcome(rawOutcome, marketType);
    if (parsed) {
      outcomes.push({
        label: parsed.label,
        odds: parsed.odds,
        provider: "pslive",
      });
    }
  }

  // Need at least 2 outcomes for a valid market
  if (outcomes.length < 2) return null;

  // For MONEYLINE, we need exactly 3 outcomes (home, draw, away)
  if (normalizedType === "match_winner" && outcomes.length !== 3) return null;

  // For totals, we need exactly 2 outcomes (over, under)
  if (normalizedType === "totals" && outcomes.length !== 2) return null;

  // Build param for totals (include period type if not Regular)
  let param: string | undefined;
  if (normalizedType === "totals") {
    param = String(handicap);
    if (periodType !== "Regular") {
      param = `${handicap}|${periodType}`;
    }
  }

  return {
    eventId,
    type: normalizedType,
    param,
    outcomes,
  };
}

interface ParsedEventData {
  event: NormalizedEvent;
  markets: NormalizedMarket[];
}

function parseEvent(
  rawEvent: PSLiveEvent,
  leagueName: string
): ParsedEventData | null {
  const eventId = rawEvent[0];
  const homeTeam = rawEvent[2];
  const awayTeam = rawEvent[3];
  const periods = rawEvent[5];

  // Skip events without valid team names
  if (!homeTeam || !awayTeam) return null;

  // Find start time from first period
  let startTime = new Date();
  if (periods.length > 0) {
    startTime = new Date(periods[0][2]);
  }

  const normalizedEventId = `pslive-${eventId}`;

  const event: NormalizedEvent = {
    id: normalizedEventId,
    sport: "football",
    homeTeam,
    awayTeam,
    competition: leagueName,
    startTime,
    providers: {
      pslive: {
        eventId: String(eventId),
        fetchedAt: new Date(),
      },
    },
  };

  // Parse markets from all periods
  const markets: NormalizedMarket[] = [];
  for (const period of periods) {
    const hasMarkets = period[4];
    if (!hasMarkets) continue;

    const rawMarkets = period[5];
    for (const rawMarket of rawMarkets) {
      const market = parseMarket(rawMarket, normalizedEventId);
      if (market) {
        markets.push(market);
      }
    }
  }

  return { event, markets };
}

function parseResponse(response: PSLiveResponse): {
  events: NormalizedEvent[];
  markets: NormalizedMarket[];
} {
  const events: NormalizedEvent[] = [];
  const markets: NormalizedMarket[] = [];

  const sports = response.data[3];

  for (const sport of sports) {
    const sportId = sport[0];
    if (sportId !== SOCCER_SPORT_ID) continue;

    const statusGroups = sport[3];
    for (const statusGroup of statusGroups) {
      const leagues = statusGroup[1];
      for (const league of leagues) {
        const leagueName = league[1];
        const rawEvents = league[2];

        for (const rawEvent of rawEvents) {
          const parsed = parseEvent(rawEvent, leagueName);
          if (parsed) {
            events.push(parsed.event);
            markets.push(...parsed.markets);
          }
        }
      }
    }
  }

  return { events, markets };
}

// ============================================================
// Markets Cache (same pattern as NineWickets)
// ============================================================

const marketsCache = new Map<string, NormalizedMarket[]>();

// ============================================================
// Adapter Export
// ============================================================

// Helper to make API request with token
async function fetchWithToken(token: string): Promise<NormalizedEvent[]> {
  const url = buildEventsUrl();
  const response = await client.get(url, {
    headers: { Authorization: token },
  });

  // Validate response structure
  const parsed = PSLiveResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    console.error("[pslive] Invalid response structure:", parsed.error.message);
    return [];
  }

  // Check API response code
  if (parsed.data.code !== 200) {
    console.error("[pslive] API error:", parsed.data.message);
    return [];
  }

  // Parse events and markets
  const { events, markets } = parseResponse(parsed.data);

  // Update markets cache
  marketsCache.clear();
  for (const market of markets) {
    const existing = marketsCache.get(market.eventId) || [];
    existing.push(market);
    marketsCache.set(market.eventId, existing);
  }

  console.log(`[pslive] Fetched ${events.length} events, ${markets.length} markets`);
  return events;
}

export const psliveAdapter: ProviderAdapter = {
  name: "pslive",

  async fetchEvents(): Promise<NormalizedEvent[]> {
    // Get token (auto-refreshes if expired)
    const token = await getPsliveToken();
    if (!token) {
      console.warn("[pslive] No valid token - skipping fetchEvents");
      return [];
    }

    try {
      return await fetchWithToken(token);
    } catch (error) {
      // On 401, force token refresh and retry once
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        console.log("[pslive] Got 401, forcing token refresh...");
        const freshToken = await getPsliveToken(true); // force refresh
        if (freshToken) {
          try {
            return await fetchWithToken(freshToken);
          } catch (retryError) {
            console.error("[pslive] Retry failed after token refresh");
          }
        }
      }

      if (axios.isAxiosError(error)) {
        console.error("[pslive] API request failed:", error.response?.status, error.message);
      } else {
        console.error("[pslive] fetchEvents error:", error);
      }
      return [];
    }
  },

  async fetchMarkets(eventId: string): Promise<NormalizedMarket[]> {
    // Markets are already fetched with events, return from cache
    return marketsCache.get(eventId) || [];
  },
};
