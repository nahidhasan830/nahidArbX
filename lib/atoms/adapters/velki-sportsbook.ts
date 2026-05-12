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
import { logger } from "../../shared/logger";

const PROVIDER: ProviderKey = "velki-sportsbook";

interface VelkiSportsbookRawData {
  markets: VelkiSportsbookMarket[];
  homeTeam: string;
  awayTeam: string;
}

export class VelkiSportsbookAtomsAdapter extends BaseAtomsAdapter {
  readonly providerId: ProviderKey = PROVIDER;

  async fetchAndStoreOdds(
    _providerEventId: string,
    _normalizedEventId: string,
    _homeTeam: string,
    _awayTeam: string,
  ): Promise<number> {
    // LEGACY: The 15-second polling loop calls this.
    // We now use real-time continuous polling (`genius-sports-sync-service.ts`), so we do not
    // fetch odds via REST here anymore to avoid duplicate work.
    // The X-Ray diagnostics UI still uses `debugFetchRawData` below.
    return 0;
  }

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

      // Collect entries per market to detect atom collisions before storing
      const marketEntries: NormalizedOddsEntry[] = [];
      const seenAtoms = new Set<string>();
      let hasCollision = false;

      for (const selection of selections) {
        if (!selection.isActive) continue;

        const atomId = mapSportsbookToAtom(
          market.apiSiteMarketType ?? 0,
          selection.selectionName,
          market.marketName,
          data.homeTeam,
          data.awayTeam,
          undefined, // handicap
          ctx.resolvedSelections,
        );

        if (!atomId) continue;

        // Collision detection: two selections mapping to the same atom
        // is always a mapping bug (e.g. fuzzy matching failure)
        if (seenAtoms.has(atomId)) {
          hasCollision = true;
          logger.warn(
            "VelkiSportsbook",
            `Atom collision in "${market.marketName}": ${atomId} mapped by "${selection.selectionName}" (already seen) — skipping market`,
          );
          break;
        }
        seenAtoms.add(atomId);

        const entry = buildOddsEntry(
          this.providerId,
          ctx.normalizedEventId,
          atomId,
          selection.odds,
          timestamp,
          isSuspended || undefined,
        );
        if (entry) {
          marketEntries.push(entry);
        }
      }

      // Skip entire market on collision — all entries are suspect
      if (hasCollision) continue;

      for (const entry of marketEntries) {
        entries.push(entry);
        // Stash min/max stake limits keyed by atom — placement modal
        // reads these directly without a second round-trip.
        if (typeof market.min === "number" && typeof market.max === "number") {
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

    return entries;
  }
}
