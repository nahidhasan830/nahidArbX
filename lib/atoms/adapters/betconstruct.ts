
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


const PROVIDER: ProviderKey = "betconstruct";


export class BetConstructAtomsAdapter extends BaseAtomsAdapter {
  readonly providerId: ProviderKey = PROVIDER;

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
    return 0;
  }

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

    for (const market of Object.values(game.market)) {
      if (!isSupportedMarketType(market.type)) {
        continue;
      }

      if (!market.event || Object.keys(market.event).length === 0) continue;

      const marketEntries = extractBetConstructOdds(
        market,
        ctx.normalizedEventId,
      );
      entries.push(...marketEntries);
    }

    return entries;
  }
}


const adapterInstance = new BetConstructAtomsAdapter();


export { adapterInstance as betconstructAtomsAdapter };
