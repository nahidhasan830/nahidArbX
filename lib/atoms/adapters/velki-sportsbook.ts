
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
import {
  selectPreferredGeniusEntries,
  type GeniusEntryCandidate,
} from "./genius-market-dedupe";

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
    return 0;
  }

  protected async fetchRawData(
    ctx: FetchContext,
  ): Promise<VelkiSportsbookRawData | null> {
    const catalog = await queryGeniusSportsCatalog(ctx.providerEventId);
    const allMarkets = catalog.geniusSportsMarkets;
    if (!allMarkets || allMarkets.length === 0) return null;

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
    const candidates: GeniusEntryCandidate[] = [];
    const timestamp = Date.now();
    let order = 0;

    for (const market of data.markets) {
      const selections = market.geniusSportsSelection;
      if (!selections || selections.length === 0) continue;

      const isSuspended =
        market.apiSiteStatus !== undefined && market.apiSiteStatus !== "OPEN";

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

      if (hasCollision) continue;

      for (const entry of marketEntries) {
        candidates.push({ entry, market, order: order++ });
      }
    }

    const preferred = selectPreferredGeniusEntries(candidates);

    for (const { entry, market } of preferred) {
      if (typeof market.min === "number" && typeof market.max === "number") {
        setMarketLimits(this.providerId, ctx.normalizedEventId, entry.atom_id, {
          minBet: market.min,
          maxBet: market.max,
          marketId: String(market.id),
          timestamp,
        });
      }
    }

    return preferred.map(({ entry }) => entry);
  }
}
