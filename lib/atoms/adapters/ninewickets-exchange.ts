/**
 * NineWickets Exchange Atoms Adapter
 *
 * Fetches exchange odds and stores them in the atoms store.
 * Exchange offers 4 markets: MATCH_ODDS, O/U 0.5, 1.5, 2.5
 */

import { BaseAtomsAdapter, type FetchContext } from "./base";
import { buildOddsEntry } from "../../shared/odds-entry";
import { DebugFetcher } from "../../shared/debug-fetcher";
import { validateAndParse } from "../../shared/validation";
import { createProviderClient } from "../../shared/http";
import {
  MarketsResponseSchema,
  type MarketsResponse,
} from "../../shared/schemas/ninewickets";
import { mapExchangeToAtom } from "../mappings/ninewickets-exchange";
import type { NormalizedOddsEntry, ProviderKey } from "../types";

// ============================================
// Constants
// ============================================

const PROVIDER: ProviderKey = "ninewickets-exchange";
const MARKETS_BASE_URL = "https://awskvx.seofmi.live";
const MARKETS_ENDPOINT = "/exchange/member/playerService/queryMarkets";

// ============================================
// Axios Client
// ============================================

const marketsClient = createProviderClient({
  baseURL: MARKETS_BASE_URL,
  contentType: "form-urlencoded",
  timeout: 5000,
});

// ============================================
// Adapter Class
// ============================================

export class NineWicketsExchangeAtomsAdapter extends BaseAtomsAdapter {
  readonly providerId: ProviderKey = PROVIDER;

  protected async fetchRawData(
    ctx: FetchContext,
  ): Promise<MarketsResponse | null> {
    const params = new URLSearchParams({
      eventId: ctx.providerEventId,
      selectionTs: "0",
    });

    const response = await marketsClient.post(
      MARKETS_ENDPOINT,
      params.toString(),
    );

    return validateAndParse(
      response.data,
      MarketsResponseSchema,
      `[NW Exchange Atoms] event ${ctx.providerEventId}`,
    );
  }

  protected extractOdds(
    rawData: unknown,
    ctx: FetchContext,
  ): NormalizedOddsEntry[] {
    const data = rawData as MarketsResponse;
    const entries: NormalizedOddsEntry[] = [];
    const timestamp = Date.now();

    for (const market of data.markets) {
      if (!market.selections || market.selections.length === 0) continue;

      for (const selection of market.selections) {
        const backPrices = selection.availableToBack;
        if (!backPrices || backPrices.length === 0) continue;

        const odds = backPrices[0].price;
        const atomId = mapExchangeToAtom(
          market.marketType,
          selection.runnerName,
          ctx.homeTeam,
          ctx.awayTeam,
        );

        const entry = buildOddsEntry(
          this.providerId,
          ctx.normalizedEventId,
          atomId,
          odds,
          timestamp,
        );
        if (entry) entries.push(entry);
      }
    }

    return entries;
  }

  protected captureDebugRequest(debug: DebugFetcher, ctx: FetchContext): void {
    const params = new URLSearchParams({
      eventId: ctx.providerEventId,
      selectionTs: "0",
    });

    debug.captureRequest({
      url: `${MARKETS_BASE_URL}${MARKETS_ENDPOINT}`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  }

  protected async debugFetchRawData(
    debug: DebugFetcher,
    ctx: FetchContext,
  ): Promise<MarketsResponse | null> {
    const params = new URLSearchParams({
      eventId: ctx.providerEventId,
      selectionTs: "0",
    });

    const data = await debug.executeWithCapture(() =>
      marketsClient.post(MARKETS_ENDPOINT, params.toString()),
    );

    if (!data) return null;

    return validateAndParse(
      data,
      MarketsResponseSchema,
      `[NW Exchange Debug] event ${ctx.providerEventId}`,
    );
  }
}

// ============================================
// Singleton instance
// ============================================

const adapterInstance = new NineWicketsExchangeAtomsAdapter();

// ============================================
// Legacy Function Exports (Backward Compatibility)
// ============================================

export async function fetchAndStoreNwExchangeOdds(
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

export async function debugFetchAndStoreNwExchangeOdds(
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
