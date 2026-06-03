/**
 * SABA Sportsbook events adapter.
 *
 * Pulls real soccer fixtures from SABA's direct odds API:
 *   - GameId=1, DateType=e for upcoming
 *   - GameId=1, DateType=t for today's board
 *   - GameId=1, DateType=l for live
 *
 * SABA virtual soccer is also exposed under GameId=1, so we filter known
 * virtual soccer league groups before handing events to the shared matcher.
 */

import type { ProviderAdapter, NormalizedEvent, Provider } from "../types";
import { addDays, endOfDay } from "date-fns";
import { config } from "../config";
import { deduplicateById } from "../shared/deduplication";
import { formatError } from "../shared/errors";
import { isSabaSyntheticMarketFixture } from "./saba-filters";
import {
  fetchRealSoccerEvents,
  fetchSoccerShowAllOdds,
  type SabaMatch,
  type SabaShowAllOddsData,
} from "../betting/saba/events-client";
import type { DebugFixturesFetchResult } from "./debug-fetch";

const PROVIDER_NAME: Provider = "saba-sportsbook";

const SABA_FOOTBALL_GAME_ID = 1;
const VIRTUAL_SOCCER_LEAGUE_GROUP_IDS = new Set([42, 113, 252]);
const SABA_KICKOFF_OFFSET_MS = 4 * 60 * 60 * 1000;

function cleanName(value: string | undefined): string {
  return String(value ?? "")
    .split("|")[0]
    .replace(/<[^>]+>/g, "")
    .trim();
}

function isVirtualSoccer(match: SabaMatch, leagueName: string): boolean {
  if (VIRTUAL_SOCCER_LEAGUE_GROUP_IDS.has(match.LeagueGroupId)) return true;
  return /\bvirtual\b|\bsaba\b|\bpingoal\b|\bmarble\b|\bpes\b|\bfc\s*\d{2}\b|penalty shootout/i.test(
    leagueName,
  );
}

function parseStartTime(match: SabaMatch): Date {
  const raw = match.GameTime ?? match.Etm ?? match.Ktm;
  if (raw) {
    // SABA emits these ISO-like strings in provider time (UTC-4), without an
    // offset. Treat as UTC text first, then shift to real UTC kickoff time.
    const parsed = new Date(`${raw.replace(/Z$/, "")}Z`);
    if (!Number.isNaN(parsed.getTime())) {
      return new Date(parsed.getTime() + SABA_KICKOFF_OFFSET_MS);
    }
  }
  return new Date();
}

function transformMatch(
  match: SabaMatch,
  data: SabaShowAllOddsData,
): NormalizedEvent | null {
  if (match.GameID !== SABA_FOOTBALL_GAME_ID) return null;

  const homeTeam = cleanName(data.TeamN?.[String(match.TeamId1)]);
  const awayTeam = cleanName(data.TeamN?.[String(match.TeamId2)]);
  const competition = cleanName(data.LeagueN?.[String(match.LeagueId)]);

  if (!homeTeam || !awayTeam) return null;
  if (isVirtualSoccer(match, competition)) return null;
  if (
    isSabaSyntheticMarketFixture({
      provider: PROVIDER_NAME,
      homeTeam,
      awayTeam,
      competition,
    })
  ) {
    return null;
  }

  const eventId = String(match.MatchId);
  return {
    id: `${PROVIDER_NAME}-${eventId}`,
    sport: "football",
    homeTeam,
    awayTeam,
    competition,
    startTime: parseStartTime(match),
    providers: {
      [PROVIDER_NAME]: {
        eventId,
        fetchedAt: new Date(),
      },
    },
  };
}

function transformResponse(data: SabaShowAllOddsData): NormalizedEvent[] {
  return (data.NewMatch ?? [])
    .map((match) => transformMatch(match, data))
    .filter((event): event is NormalizedEvent => event !== null);
}

function filterToConfiguredFixtureWindow(
  events: NormalizedEvent[],
): NormalizedEvent[] {
  const cutoff = endOfDay(
    addDays(new Date(), config.providers.pinnacle.daysAhead),
  ).getTime();
  return events.filter((event) => event.startTime.getTime() <= cutoff);
}

export const sabaSportsbookAdapter: ProviderAdapter = {
  name: PROVIDER_NAME,

  async fetchEvents(): Promise<NormalizedEvent[]> {
    const { upcoming, today, live } = await fetchRealSoccerEvents();
    return filterToConfiguredFixtureWindow(
      deduplicateById([
        ...transformResponse(upcoming),
        ...transformResponse(today),
        ...transformResponse(live),
      ]),
    );
  },
};

export async function debugFetchSabaSportsbookEvents(): Promise<DebugFixturesFetchResult> {
  const result: DebugFixturesFetchResult = {
    provider: PROVIDER_NAME,
    providerRequests: [],
    rawResponses: [],
    normalizedEvents: [],
    eventCount: 0,
  };

  const start = Date.now();
  try {
    const [upcoming, today, live] = await Promise.all([
      fetchSoccerShowAllOdds("e"),
      fetchSoccerShowAllOdds("t"),
      fetchSoccerShowAllOdds("l"),
    ]);
    const durationMs = Date.now() - start;

    result.providerRequests.push(
      {
        label: "ShowAllOdds soccer upcoming",
        url: "https://<odds-host>/BFOdds/ShowAllOdds",
        method: "POST",
        headers: {
          Authorization: "Bearer [REDACTED]",
          "Content-Type": "multipart/form-data",
        },
        body: "GameId=1&DateType=e",
      },
      {
        label: "ShowAllOdds soccer today",
        url: "https://<odds-host>/BFOdds/ShowAllOdds",
        method: "POST",
        headers: {
          Authorization: "Bearer [REDACTED]",
          "Content-Type": "multipart/form-data",
        },
        body: "GameId=1&DateType=t",
      },
      {
        label: "ShowAllOdds soccer live",
        url: "https://<odds-host>/BFOdds/ShowAllOdds",
        method: "POST",
        headers: {
          Authorization: "Bearer [REDACTED]",
          "Content-Type": "multipart/form-data",
        },
        body: "GameId=1&DateType=l",
      },
    );

    result.rawResponses.push({
      status: 200,
      data: {
        upcomingCount: upcoming.NewMatch?.length ?? 0,
        todayCount: today.NewMatch?.length ?? 0,
        liveCount: live.NewMatch?.length ?? 0,
      },
      durationMs,
    });

    result.normalizedEvents = filterToConfiguredFixtureWindow(
      deduplicateById([
        ...transformResponse(upcoming),
        ...transformResponse(today),
        ...transformResponse(live),
      ]),
    );
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
