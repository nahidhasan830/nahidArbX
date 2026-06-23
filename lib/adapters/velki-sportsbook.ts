
import type { ProviderAdapter, NormalizedEvent, Provider } from "../types";
import { logger } from "../shared/logger";
import { formatError } from "../shared/errors";
import { deduplicateById } from "../shared/deduplication";
import {
  fetchAllEvents,
  type VelkiEventListEntry,
} from "../betting/velki/events-client";
import type { DebugFixturesFetchResult } from "./debug-fetch";

const PROVIDER_NAME: Provider = "velki-sportsbook";


function parseTeamNames(eventName: string): { home: string; away: string } {
  const parts = eventName.split(" v ");
  if (parts.length === 2) {
    return { home: parts[0].trim(), away: parts[1].trim() };
  }
  return { home: eventName, away: "" };
}

function transformEvent(event: VelkiEventListEntry): NormalizedEvent | null {
  const { home, away } = parseTeamNames(event.name);
  if (!home || !away) return null;

  const startMs =
    event.markets && event.markets.length > 0
      ? event.markets[0].marketDateTime
      : undefined;

  const eventId = String(event.id);

  return {
    id: `${PROVIDER_NAME}-${eventId}`,
    sport: "football",
    homeTeam: home,
    awayTeam: away,
    competition: event.competitionName,
    startTime: new Date(startMs ?? Date.now()),
    providers: {
      [PROVIDER_NAME]: {
        eventId,
        fetchedAt: new Date(),
      },
    },
  };
}


export const velkiSportsbookAdapter: ProviderAdapter = {
  name: PROVIDER_NAME,

  async fetchEvents(): Promise<NormalizedEvent[]> {
    try {
      const raw = await fetchAllEvents(1);
      const normalized = raw
        .map(transformEvent)
        .filter((e): e is NormalizedEvent => e !== null);
      return deduplicateById(normalized);
    } catch (err) {
      logger.warn("VelkiSB", `fetchEvents error: ${formatError(err)}`);
      return [];
    }
  },
};


export async function debugFetchVelkiSportsbookEvents(): Promise<DebugFixturesFetchResult> {
  const result: DebugFixturesFetchResult = {
    provider: PROVIDER_NAME,
    providerRequests: [],
    rawResponses: [],
    normalizedEvents: [],
    eventCount: 0,
  };

  const start = Date.now();
  try {
    const raw = await fetchAllEvents(1);
    const durationMs = Date.now() - start;

    result.providerRequests.push({
      label: "queryEventsWithMarket (full list)",
      url: "https://bkqawscf.fwick7ets.xyz/exchange/member/playerService/queryEventsWithMarket",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "eventType=1&eventTs=-1&marketTs=-1&selectionTs=-1&viewType=openDateTime&competitionId=-1&pageNumber=-1",
    });
    result.rawResponses.push({
      status: 200,
      data: { events: raw, count: raw.length },
      durationMs,
    });

    for (const ev of raw) {
      const transformed = transformEvent(ev);
      if (transformed) result.normalizedEvents.push(transformed);
    }
    result.normalizedEvents = deduplicateById(result.normalizedEvents);
    result.eventCount = result.normalizedEvents.length;
  } catch (err) {
    result.rawResponses.push({
      status: 500,
      data: { error: formatError(err) },
      durationMs: Date.now() - start,
    });
  }

  return result;
}
