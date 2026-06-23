
import type { ProviderAdapter, NormalizedEvent, Provider } from "../../types";
import { formatError } from "../../shared/errors";
import { deduplicateById } from "../../shared/deduplication";
import { fetchAllEvents, type BCGame } from "./client";
import { logger } from "../../shared/logger";


const PROVIDER_NAME: Provider = "betconstruct";


export interface BetConstructNormalizedEvent extends NormalizedEvent {
  liveInfo?: {
    score1: number;
    score2: number;
    gameState: string;
    minute: number;
    isLive: boolean;
  };
  suspended?: boolean;
}


function transformGame(
  game: BCGame & { competitionName?: string; regionName?: string },
): BetConstructNormalizedEvent | null {
  if (!game.team2_name) {
    return null;
  }

  if (game.team1_name === game.team2_name) {
    return null;
  }

  const isLive = game.type === 1;
  const isSuspended = game.is_blocked === 1;

  let liveInfo: BetConstructNormalizedEvent["liveInfo"];
  if (isLive && game.info) {
    liveInfo = {
      score1: parseInt(game.info.score1 || "0", 10),
      score2: parseInt(game.info.score2 || "0", 10),
      gameState: game.info.current_game_state || "unknown",
      minute: parseInt(game.info.current_game_time || "0", 10),
      isLive: true,
    };
  }

  const event: BetConstructNormalizedEvent = {
    id: `betconstruct-${game.id}`,
    sport: "football",
    homeTeam: game.team1_name,
    awayTeam: game.team2_name,
    competition: game.competitionName || "Unknown",
    startTime: new Date(game.start_ts * 1000),
    providers: {
      betconstruct: {
        eventId: String(game.id),
        fetchedAt: new Date(),
      },
    },
    liveInfo,
    suspended: isSuspended,
  };

  return event;
}


async function fetchAllBCEvents(): Promise<BetConstructNormalizedEvent[]> {
  const events: BetConstructNormalizedEvent[] = [];

  try {
    const games = await fetchAllEvents().catch((err) => {
      logger.warn("BetConstruct", "fetchAllEvents error", formatError(err));
      return [] as BCGame[];
    });

    const byType = { live: 0, prematch: 0, scheduled: 0 };
    for (const game of games) {
      if (game.type === 1) byType.live++;
      else if (game.type === 0) byType.prematch++;
      else if (game.type === 2) byType.scheduled++;
    }

    for (const game of games) {
      const event = transformGame(
        game as BCGame & { competitionName?: string; regionName?: string },
      );
      if (event) {
        events.push(event);
      }
    }
  } catch (error) {
    logger.error("BetConstruct", "fetchAllBCEvents error", formatError(error));
  }

  return events;
}


export const betconstructAdapter: ProviderAdapter = {
  name: PROVIDER_NAME,

  async fetchEvents(): Promise<NormalizedEvent[]> {
    const events = await fetchAllBCEvents();

    const deduped = deduplicateById(events);

    return deduped;
  },
};


export type { BCGame, BCMarket, BCEvent } from "./client";
