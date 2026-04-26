/**
 * BetConstruct Atoms Adapter
 *
 * Fetches market odds from BetConstruct Swarm WebSocket API and stores them in the atoms store.
 * BetConstruct offers extensive market coverage (up to 399 markets for big matches).
 *
 * Supported markets:
 * - P1XP2 (Match Result)
 * - OverUnder (Totals)
 * - BothTeamsToScore (BTTS)
 * - AsianHandicap
 * - 1X12X2 (Double Chance)
 * - HalfTimeResult
 */

import { BaseAtomsAdapter, type FetchContext } from "./base";
import { DebugFetcher } from "../../shared/debug-fetcher";
import {
  fetchGameMarkets,
  BetConstructError,
  disconnect as disconnectBC,
  reconnect as reconnectBC,
  type BCGame,
} from "../../adapters/betconstruct/client";
import {
  extractBetConstructOdds,
  isSupportedMarketType,
} from "../mappings/betconstruct";
import type { NormalizedOddsEntry, ProviderKey } from "../types";
import { stopBCScorePolling } from "../../scores/bc-poller";
import { logger } from "../../shared/logger";

// ============================================
// Constants
// ============================================

const PROVIDER: ProviderKey = "betconstruct";

// ============================================
// Adapter Class
// ============================================

export class BetConstructAtomsAdapter extends BaseAtomsAdapter {
  readonly providerId: ProviderKey = PROVIDER;

  /**
   * BC keeps a persistent WebSocket and a 10s score poller alive independently
   * of the sync pipeline, so toggling it from the UI needs explicit lifecycle
   * handling. Other providers don't override these hooks.
   */
  async onEnable(): Promise<void> {
    try {
      await reconnectBC();
    } catch (err) {
      logger.warn(
        "BetConstructAtoms",
        `reconnect failed: ${(err as Error).message}`,
      );
    }
  }

  onDisable(): void {
    disconnectBC();
    stopBCScorePolling();
  }

  protected async fetchRawData(ctx: FetchContext): Promise<BCGame | null> {
    // Extract numeric game ID from provider event ID
    const gameId = parseInt(ctx.providerEventId, 10);
    if (isNaN(gameId)) {
      logger.warn("BetConstruct", `Invalid game ID: ${ctx.providerEventId}`);
      return null;
    }

    try {
      const game = await fetchGameMarkets(gameId);

      if (!game) {
        // No game data but no error - just return null silently
        return null;
      }

      return game;
    } catch (error) {
      // Handle BetConstruct-specific errors
      if (error instanceof BetConstructError) {
        // Silent errors (e.g., code 40 = game not found) don't need logging
        if (!error.silent) {
          logger.warn("BetConstruct", `${error.message} (game ${gameId})`);
        }
        return null;
      }
      // Re-throw other errors to be handled by base adapter
      throw error;
    }
  }

  protected extractOdds(
    rawData: unknown,
    ctx: FetchContext,
  ): NormalizedOddsEntry[] {
    const game = rawData as BCGame;
    const entries: NormalizedOddsEntry[] = [];

    if (!game.market || Object.keys(game.market).length === 0) {
      return entries;
    }

    // Extract odds from each supported market
    for (const market of Object.values(game.market)) {
      // Skip unsupported market types
      if (!isSupportedMarketType(market.type)) continue;

      // Skip markets without selections
      if (!market.event || Object.keys(market.event).length === 0) continue;

      // Extract odds from this market
      const marketEntries = extractBetConstructOdds(
        market,
        ctx.normalizedEventId,
      );
      entries.push(...marketEntries);
    }

    return entries;
  }

  protected captureDebugRequest(debug: DebugFetcher, ctx: FetchContext): void {
    const gameId = parseInt(ctx.providerEventId, 10);

    debug.captureRequest({
      url: "wss://eu-swarm-newm.betconstruct.com/",
      method: "WebSocket",
      headers: { Origin: "https://bc.cc2ps.cc" },
      body: JSON.stringify({
        command: "get",
        params: {
          source: "betting",
          what: {
            game: [
              "id",
              "stats",
              "info",
              "markets_count",
              "type",
              "start_ts",
              "team1_id",
              "team1_name",
              "team2_id",
              "team2_name",
              "is_blocked",
            ],
            market: ["id", "type", "name", "base", "display_key", "express_id"],
            event: ["id", "type_1", "price", "name", "base", "order"],
          },
          where: {
            game: { id: gameId },
            sport: { alias: "Soccer" },
          },
          subscribe: false,
        },
      }),
    });
  }

  protected async debugFetchRawData(
    debug: DebugFetcher,
    ctx: FetchContext,
  ): Promise<BCGame | null> {
    const gameId = parseInt(ctx.providerEventId, 10);
    if (isNaN(gameId)) return null;

    const startTime = Date.now();
    try {
      const game = await fetchGameMarkets(gameId);
      const durationMs = Date.now() - startTime;

      // Manually add response for WebSocket call
      debug.addResponse({
        status: game ? 200 : 404,
        data: game ?? { error: "No game data returned" },
        durationMs,
      });

      return game;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      // Handle BetConstruct-specific errors with proper status codes
      if (error instanceof BetConstructError) {
        debug.addResponse({
          status: error.code === 40 ? 404 : 500,
          data: {
            error: error.message,
            code: error.code,
            silent: error.silent,
          },
          durationMs,
        });
        return null;
      }

      debug.addResponse({
        status: 500,
        data: {
          error: error instanceof Error ? error.message : "Unknown error",
        },
        durationMs,
      });
      return null;
    }
  }
}

// ============================================
// Singleton instance
// ============================================

const adapterInstance = new BetConstructAtomsAdapter();

// ============================================
// Legacy Function Exports (Backward Compatibility)
// ============================================

export async function fetchAndStoreBetConstructOdds(
  providerEventId: string,
  normalizedEventId: string,
  homeTeam: string,
  awayTeam: string,
): Promise<number> {
  return adapterInstance.fetchAndStoreOdds(
    providerEventId,
    normalizedEventId,
    homeTeam,
    awayTeam,
  );
}

export async function debugFetchAndStoreBetConstructOdds(
  providerEventId: string,
  normalizedEventId: string,
  homeTeam: string,
  awayTeam: string,
) {
  return adapterInstance.debugFetchAndStoreOdds(
    providerEventId,
    normalizedEventId,
    homeTeam,
    awayTeam,
  );
}

// ============================================
// Export adapter instance
// ============================================

export { adapterInstance as betconstructAtomsAdapter };
