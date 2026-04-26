/**
 * Velki Sportsbook atoms adapter.
 *
 * Pulls Genius Sports market odds from Velki's PROVIDER tier
 * (bkqawscf.fwick7ets.xyz) and stores them in the atoms odds store.
 *
 * Uses the SAME 2-step flow as 9W Sportsbook:
 *   1. Catalog (version=0) — full market structure, no live prices
 *   2. Odds (with marketIds + version) — live prices for all markets
 *
 * Differences vs 9W:
 *   • Different host (bkqawscf.fwick7ets.xyz, not gakvx.seofmi.live)
 *   • apiSiteType = 4 (vs 5 for 9W)
 *   • Auth via JSESSIONID captured by Velki's REST/SSO chain (no
 *     Playwright)
 *
 * The atoms mapping is shared verbatim with 9W (sister deployment of
 * the same Genius Sports platform — same market names, same
 * apiSiteMarketType codes).
 */

import { BaseAtomsAdapter, type FetchContext } from "./base";
import { buildOddsEntry } from "../../shared/odds-entry";
import { setMarketLimits } from "../market-limits-store";
import type { NormalizedOddsEntry, ProviderKey } from "../types";
import { mapSportsbookToAtom } from "../mappings/velki-sportsbook";
import {
  queryGeniusSportsCatalog,
  queryGeniusSportsOdds,
  type VelkiSportsbookMarket,
} from "../../betting/velki/events-client";

const PROVIDER: ProviderKey = "velki-sportsbook";

interface VelkiSportsbookRawData {
  markets: VelkiSportsbookMarket[];
  homeTeam: string;
  awayTeam: string;
}

export class VelkiSportsbookAtomsAdapter extends BaseAtomsAdapter {
  readonly providerId: ProviderKey = PROVIDER;

  protected async fetchRawData(
    ctx: FetchContext,
  ): Promise<VelkiSportsbookRawData | null> {
    const catalog = await queryGeniusSportsCatalog(ctx.providerEventId);
    const allMarkets = catalog.geniusSportsMarkets;
    if (!allMarkets || allMarkets.length === 0) return null;

    // No live filter — verified empirically that Velki's odds endpoint
    // self-filters to tradeable markets, AND that filtering on the
    // catalog-side `marketLive` flag drops most markets even when the
    // event is in-play (102 of 181 passed the filter but only 1 had
    // selections, vs. 184 with selections when unfiltered). The 9W
    // pattern doesn't translate — different field semantics.
    const marketIds = allMarkets.map((m) => m.id);
    const selectionTsList = allMarkets.map((m) => m.selectionTs ?? -1);
    const version = catalog.version ?? 0;

    const oddsData = await queryGeniusSportsOdds(
      ctx.providerEventId,
      version,
      marketIds,
      selectionTsList,
    );
    if (!oddsData?.geniusSportsMarkets) return null;

    return {
      markets: oddsData.geniusSportsMarkets,
      homeTeam: ctx.homeTeam,
      awayTeam: ctx.awayTeam,
    };
  }

  protected extractOdds(
    rawData: unknown,
    ctx: FetchContext,
  ): NormalizedOddsEntry[] {
    const data = rawData as VelkiSportsbookRawData;
    const entries: NormalizedOddsEntry[] = [];
    const timestamp = Date.now();

    for (const market of data.markets) {
      const selections = market.geniusSportsSelection;
      if (!selections || selections.length === 0) continue;

      const isSuspended =
        market.apiSiteStatus !== undefined && market.apiSiteStatus !== "OPEN";

      for (const selection of selections) {
        if (!selection.isActive) continue;

        const atomId = mapSportsbookToAtom(
          market.apiSiteMarketType ?? 0,
          selection.selectionName,
          market.marketName,
          data.homeTeam,
          data.awayTeam,
        );

        const entry = buildOddsEntry(
          this.providerId,
          ctx.normalizedEventId,
          atomId,
          selection.odds,
          timestamp,
          isSuspended || undefined,
        );
        if (entry) {
          entries.push(entry);
          // Stash min/max stake limits keyed by atom — placement modal
          // reads these directly without a second round-trip.
          if (
            typeof market.min === "number" &&
            typeof market.max === "number"
          ) {
            setMarketLimits(
              this.providerId,
              ctx.normalizedEventId,
              entry.atom_id,
              {
                minBet: market.min,
                maxBet: market.max,
                marketId: market.id,
                timestamp,
              },
            );
          }
        }
      }
    }

    return entries;
  }
}

// ============================================================
// Legacy function exports (for /api/value-bets/raw-data debug route)
// ============================================================

const adapterInstance = new VelkiSportsbookAtomsAdapter();

export async function debugFetchAndStoreVelkiSportsbookOdds(
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
