/**
 * BetConstruct Adapter
 *
 * Fetches events and markets from the BetConstruct Swarm WebSocket API.
 *
 * Features:
 * - Both prematch and live events
 * - Live scores (info.score1, info.score2)
 * - Suspended status (is_blocked)
 * - 399 markets for big matches
 */

import type { ProviderAdapter, NormalizedEvent, Provider } from "../../types";
import { formatError } from "../../shared/errors";
import { deduplicateById } from "../../shared/deduplication";
import { fetchAllEvents, type BCGame } from "./client";
import { logger } from "../../shared/logger";

// ============================================
// Constants
// ============================================

const PROVIDER_NAME: Provider = "betconstruct";

// ============================================
// Extended Event Type with Live Info
// ============================================

export interface BetConstructNormalizedEvent extends NormalizedEvent {
  // Live match info
  liveInfo?: {
    score1: number;
    score2: number;
    gameState: string; // "set1", "set2", "Half Time", "notstarted"
    minute: number;
    isLive: boolean;
  };
  // Suspended status
  suspended?: boolean;
}

// ============================================
// Helper Functions
// ============================================

function transformGame(
  game: BCGame & { competitionName?: string; regionName?: string },
): BetConstructNormalizedEvent | null {
  // Skip games without team2 (outright markets)
  if (!game.team2_name) {
    return null;
  }

  // Skip if both team names are the same (invalid match)
  if (game.team1_name === game.team2_name) {
    return null;
  }

  const isLive = game.type === 1;
  const isSuspended = game.is_blocked === 1;

  // Parse live info
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

// ============================================
// Event Fetching
// ============================================

async function fetchAllBCEvents(): Promise<BetConstructNormalizedEvent[]> {
  const events: BetConstructNormalizedEvent[] = [];

  try {
    // Single optimized query fetches all event types (live, prematch, scheduled)
    const games = await fetchAllEvents().catch((err) => {
      logger.warn("BetConstruct", "fetchAllEvents error", formatError(err));
      return [] as BCGame[];
    });

    // Count by type for logging
    const byType = { live: 0, prematch: 0, scheduled: 0 };
    for (const game of games) {
      if (game.type === 1) byType.live++;
      else if (game.type === 0) byType.prematch++;
      else if (game.type === 2) byType.scheduled++;
    }

    // Transform all games
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

// ============================================
// Provider Adapter
// ============================================

export const betconstructAdapter: ProviderAdapter = {
  name: PROVIDER_NAME,

  async fetchEvents(): Promise<NormalizedEvent[]> {
    const events = await fetchAllBCEvents();

    // Deduplicate by event ID (in case a match appears in both live and prematch)
    const deduped = deduplicateById(events);

    return deduped;
  },
};

// ============================================
// Re-exports (types only — all function callers import from ./client directly)
// ============================================

export type { BCGame, BCMarket, BCEvent } from "./client";
