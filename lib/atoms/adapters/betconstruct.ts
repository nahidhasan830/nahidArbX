/**
 * BetConstruct Atoms Adapter
 *
 * Extracts normalized odds entries from BetConstruct Swarm market data
 * and stores them in the atoms store via `processRawOdds()`.
 *
 * Odds ingestion is driven by `BetConstructSyncService` which subscribes
 * to Swarm WebSocket push updates and feeds raw BCGame data here.
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

import {
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

  async fetchAndStoreOdds(): Promise<number> {
    // Odds ingestion is handled by BetConstructSyncService (Swarm WS
    // subscriptions → processRawOdds → setOddsBatch). This legacy
    // entry point is no longer used.
    return 0;
  }

  // fetchRawData is required by the abstract base class but never called
  // since fetchAndStoreOdds is neutralized. processRawOdds (used by the
  // sync service) calls extractOdds directly, bypassing fetchRawData.
  protected async fetchRawData(): Promise<BCGame | null> {
    return null;
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
      if (!isSupportedMarketType(market.type)) {
        continue;
      }

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

}

// ============================================
// Singleton instance
// ============================================

const adapterInstance = new BetConstructAtomsAdapter();

// ============================================
// Export adapter instance
// ============================================

export { adapterInstance as betconstructAtomsAdapter };
