/**
 * Velki Sportsbook Adapter
 *
 * Pulls fixtures from the Velki PROVIDER tier (bkqawscf.fwick7ets.xyz)
 * via queryEventsWithMarket. We send `pageNumber=-1` so the platform
 * returns the entire live + upcoming surface in one response (~250
 * events) — no pagination walk required.
 *
 * Auth runs through lib/betting/velki/session.ts (DRF token → SSO
 * handoff → JSESSIONID). Per-event sportsbook odds are fetched later
 * by the atoms adapter (queryGeniusSportsEvent).
 *
 * Event-name format is "Team A v Team B" — same as 9W — so the
 * existing event matcher (lib/matching/matcher.ts) will line Velki
 * events up against Pinnacle / NineWickets / BetConstruct without
 * any provider-specific code.
 */

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

// ============================================================
// Helpers
// ============================================================

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

  // Velki returns the event-level marketDateTime via the first market
  // entry; fall back to "now" only if missing (better than rejecting).
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

// ============================================================
// Provider Adapter
// ============================================================

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

// ============================================================
// Debug Fetch (for /debug-machine pipeline)
// ============================================================

export async function debugFetchVelkiSportsbookEvents(): Promise<DebugFixturesFetchResult> {
  const result: DebugFixturesFetchResult = {
    provider: PROVIDER_NAME,
    providerRequests: [],
    rawResponses: [],
    normalizedEvents: [],
    eventCount: 0,
  };

  // Single-shot request — `pageNumber=-1` disables pagination and
  // returns the full event list in one response.
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
