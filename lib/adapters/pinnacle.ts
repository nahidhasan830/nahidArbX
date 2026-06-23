
import axios from "axios";
import type { ProviderAdapter, NormalizedEvent } from "../types";
import { getPinnacleToken, clearStoredToken } from "../auth/token-manager";
import { validateAndParse } from "../shared/validation";
import { formatError } from "../shared/errors";
import { config } from "../config";
import { logger } from "../shared/logger";
import {
  SOCCER_SPORT_ID,
  PinnacleEventsResponseSchema,
  type PinnacleEventsResponse,
  type PinnacleEvent,
} from "./pinnacle/schemas";
import { buildEventsUrl } from "./pinnacle/urls";
import { pinnacleClient } from "./pinnacle/client";
import type { DebugFixturesFetchResult } from "./debug-fetch";

export { SOCCER_SPORT_ID, PinnacleResponseSchema } from "./pinnacle/schemas";
export type {
  PinnacleResponse,
  PinnacleEvent,
  PinnaclePeriod,
} from "./pinnacle/schemas";
export { buildEventsUrl } from "./pinnacle/urls";


export function parseEvent(
  rawEvent: PinnacleEvent,
  leagueName: string,
): NormalizedEvent | null {
  const eventId = rawEvent[0];
  const homeTeam = rawEvent[2];
  const awayTeam = rawEvent[3];
  const periods = rawEvent[5];

  if (!homeTeam || !awayTeam) return null;

  let startTime = new Date();
  if (periods.length > 0) {
    startTime = new Date(periods[0][2]);
  }

  return {
    id: `pinnacle-${eventId}`,
    sport: "football",
    homeTeam,
    awayTeam,
    competition: leagueName,
    startTime,
    providers: {
      pinnacle: {
        eventId: String(eventId),
        fetchedAt: new Date(),
      },
    },
  };
}

export function parseResponse(
  response: PinnacleEventsResponse,
): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
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
          const event = parseEvent(rawEvent, leagueName);
          if (event) {
            events.push(event);
          }
        }
      }
    }
  }

  return events;
}


async function fetchWithToken(token: string): Promise<NormalizedEvent[]> {
  const url = buildEventsUrl();
  const response = await pinnacleClient.get(url, {
    headers: { Authorization: token },
  });

  const parsed = validateAndParse(
    response.data,
    PinnacleEventsResponseSchema,
    "[pinnacle] events",
  );
  if (!parsed) {
    throw new Error("Pinnacle events response failed schema validation");
  }

  if (parsed.code !== 200) {
    throw new Error(`Pinnacle API error ${parsed.code}: ${parsed.message}`);
  }

  const events = parseResponse(parsed);
  return events;
}

export const pinnacleAdapter: ProviderAdapter = {
  name: "pinnacle",

  async fetchEvents(): Promise<NormalizedEvent[]> {
    const token = await getPinnacleToken();
    if (!token) {
      throw new Error("No valid Pinnacle token available");
    }

    try {
      return await fetchWithToken(token);
    } catch (error) {
      let finalError = error;

      if (axios.isAxiosError(error) && error.response?.status === 401) {
        clearStoredToken();
        const freshToken = await getPinnacleToken(true);
        if (freshToken) {
          try {
            return await fetchWithToken(freshToken);
          } catch (retryError) {
            finalError = retryError;
            if (
              axios.isAxiosError(retryError) &&
              retryError.response?.status === 401
            ) {
              logger.error(
                "Pinnacle",
                "Retry also got 401 - token capture may have failed",
              );
              clearStoredToken();
            } else {
              logger.error("Pinnacle", "Retry failed after token refresh");
            }
          }
        } else {
          finalError = new Error(
            "Token refresh returned null - browser capture failed",
          );
        }
      }

      if (axios.isAxiosError(finalError)) {
        logger.error(
          "Pinnacle",
          `API request failed: ${finalError.response?.status} ${finalError.message}`,
        );
      } else {
        logger.error("Pinnacle", "fetchEvents error", finalError);
      }
      throw finalError;
    }
  },
};


export async function debugFetchPinnacleEvents(): Promise<DebugFixturesFetchResult> {
  const result: DebugFixturesFetchResult = {
    provider: "pinnacle",
    providerRequests: [],
    rawResponses: [],
    normalizedEvents: [],
    eventCount: 0,
  };

  try {
    const token = await getPinnacleToken();
    if (!token) {
      return result;
    }

    const urlPath = buildEventsUrl();
    const fullUrl = `${config.providers.pinnacle.baseUrl}${urlPath}`;

    result.providerRequests.push({
      label: "Fetch Events",
      url: fullUrl,
      method: "GET",
      headers: { Authorization: "Bearer [REDACTED]" },
    });

    const startTime = Date.now();
    const response = await pinnacleClient.get(urlPath, {
      headers: { Authorization: token },
    });
    const durationMs = Date.now() - startTime;

    result.rawResponses.push({
      status: response.status,
      data: response.data,
      durationMs,
    });

    const parsed = validateAndParse(
      response.data,
      PinnacleEventsResponseSchema,
      "[pinnacle debug]",
    );
    if (!parsed || parsed.code !== 200) return result;

    const events = parseResponse(parsed);
    result.normalizedEvents = events;
    result.eventCount = events.length;
  } catch (error) {
    logger.error("Pinnacle", `debug fetch error: ${formatError(error)}`);
  }

  return result;
}
