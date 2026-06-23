
import { z } from "zod";
import { BaseAtomsAdapter, type FetchContext } from "./base";
import { buildOddsEntry } from "../../shared/odds-entry";
import { validateAndParse } from "../../shared/validation";
import { createProviderClient } from "../../shared/http";
import type { NormalizedOddsEntry, ProviderKey } from "../types";
import { mapSportsbookToAtom } from "../mappings/ninewickets-sportsbook";
import { setMarketLimits } from "../market-limits-store";
import {
  selectPreferredGeniusEntries,
  type GeniusEntryCandidate,
} from "./genius-market-dedupe";
import {
  callWithSessionRetry,
  SessionExpiredError,
} from "../../betting/ninewickets/client";
import { logger } from "../../shared/logger";


const PROVIDER: ProviderKey = "ninewickets-sportsbook";
const ENDPOINT_URL =
  "https://gakvx.seofmi.live/exchange/member/playerService/queryGeniusSportsEvent";


function buildCatalogParams(providerEventId: string): URLSearchParams {
  return new URLSearchParams({
    apiSiteType: "5",
    eventId: providerEventId,
    version: "0",
    marketIds: ",",
    selectionTsList: ",",
    isDynamicUpdate: "0",
  });
}

function buildOddsParams(
  providerEventId: string,
  version: number,
  marketIds: string[],
  selectionTsList: number[],
): URLSearchParams {
  return new URLSearchParams({
    apiSiteType: "5",
    eventId: providerEventId,
    version: String(version),
    marketIds: marketIds.join(",") + ",",
    selectionTsList: selectionTsList.join(",") + ",",
    isDynamicUpdate: "0",
  });
}


const client = createProviderClient({
  contentType: "form-urlencoded",
  timeout: 5000,
});


const SelectionSchema = z.object({
  selectionName: z.string(),
  odds: z.number(),
  handicap: z.number(),
  isActive: z.union([z.boolean(), z.number()]).transform((v) => Boolean(v)),
  apiSiteSelectionId: z.string(),
});

const MarketSchema = z.object({
  id: z.string(),
  marketName: z.string(),
  apiSiteMarketType: z.number(),
  apiSiteStatus: z.string().optional(), // "OPEN", "SUSPENDED", "CLOSED"
  selectionTs: z.number().optional(),
  live: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  geniusSportsSelection: z.array(SelectionSchema).optional(),
});

const SportsbookResponseSchema = z.object({
  eventId: z.number().optional(),
  eventName: z.string().optional(),
  version: z.number().optional(),
  live: z.boolean().optional(),
  geniusSportsMarkets: z.array(MarketSchema).optional(),
});

export type SportsbookMarket = z.infer<typeof MarketSchema>;


interface SportsbookRawData {
  markets: SportsbookMarket[];
  homeTeam: string;
  awayTeam: string;
}


export class NineWicketsSportsbookAtomsAdapter extends BaseAtomsAdapter {
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
  ): Promise<SportsbookRawData | null> {
    const catalogParams = buildCatalogParams(ctx.providerEventId);
    const catalogResponse = await client.post(
      ENDPOINT_URL,
      catalogParams.toString(),
    );
    const catalog = validateAndParse(
      catalogResponse.data,
      SportsbookResponseSchema,
      `[NW Sportsbook] catalog event ${ctx.providerEventId}`,
    );

    if (!catalog) return null;

    const allMarkets = catalog.geniusSportsMarkets;
    if (!allMarkets || allMarkets.length === 0) return null;

    const markets = allMarkets;

    const marketIds = markets.map((m) => m.id);
    const selectionTsList = markets.map((m) => m.selectionTs ?? -1);
    const version = catalog.version ?? 0;
    const oddsParams = buildOddsParams(
      ctx.providerEventId,
      version,
      marketIds,
      selectionTsList,
    );
    const oddsResponse = await client.post(ENDPOINT_URL, oddsParams.toString());
    const oddsData = validateAndParse(
      oddsResponse.data,
      SportsbookResponseSchema,
      `[NW Sportsbook] odds event ${ctx.providerEventId}`,
    );

    if (!oddsData || !oddsData.geniusSportsMarkets) return null;

    await overlayAuthenticatedLimits(
      ctx.providerEventId,
      oddsData.geniusSportsMarkets,
    );

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
    const data = rawData as SportsbookRawData;
    const candidates: GeniusEntryCandidate[] = [];
    const timestamp = Date.now();
    let order = 0;

    for (const market of data.markets) {
      const selections = market.geniusSportsSelection;
      if (!selections || selections.length === 0) continue;

      const isSuspended =
        market.apiSiteStatus && market.apiSiteStatus !== "OPEN";

      const marketEntries: NormalizedOddsEntry[] = [];
      const seenAtoms = new Set<string>();
      let hasCollision = false;

      for (const selection of selections) {
        if (!selection.isActive) continue;

        const atomId = mapSportsbookToAtom(
          market.apiSiteMarketType,
          selection.selectionName,
          market.marketName,
          data.homeTeam,
          data.awayTeam,
          selection.handicap,
          ctx.resolvedSelections,
        );

        if (!atomId) continue;

        if (seenAtoms.has(atomId)) {
          hasCollision = true;
          logger.warn(
            "NWSportsbook",
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
          isSuspended || undefined, // Pass suspended flag
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


export async function overlayAuthenticatedLimits(
  providerEventId: string,
  markets: SportsbookMarket[],
): Promise<void> {
  try {
    const authed = await callWithSessionRetry(async (session) => {
      const url = `https://gakvx.seofmi.live/exchange/member/playerService/queryGeniusSportsEvent;jsessionid=${session.queryPass}`;
      const body = new URLSearchParams({
        apiSiteType: "5",
        eventType: "1",
        eventId: providerEventId,
        version: "0",
        marketIds: ",",
        selectionTsList: ",",
        isDynamicUpdate: "0",
      });
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Accept: "application/json, text/plain, */*",
          Origin: "https://9wktsbest.com",
          Referer: "https://9wktsbest.com/",
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: session.queryPass,
        },
        body: body.toString(),
      });
      if (res.status === 401 || res.status === 403) {
        throw new SessionExpiredError(`limits overlay ${res.status}`);
      }
      if (!res.ok) return null;
      const text = await res.text();
      if (text.trim().startsWith("<")) {
        throw new SessionExpiredError("limits overlay returned HTML");
      }
      return JSON.parse(text) as {
        geniusSportsMarkets?: Array<{
          id?: string;
          min?: number;
          max?: number;
        }>;
      };
    });

    if (!authed?.geniusSportsMarkets) return;
    const limitsByMarketId = new Map<string, { min: number; max: number }>();
    for (const m of authed.geniusSportsMarkets) {
      if (
        typeof m.id === "string" &&
        typeof m.min === "number" &&
        typeof m.max === "number"
      ) {
        limitsByMarketId.set(m.id, { min: m.min, max: m.max });
      }
    }
    if (limitsByMarketId.size === 0) return;
    for (const market of markets) {
      const authLimits = limitsByMarketId.get(market.id);
      if (authLimits) {
        market.min = authLimits.min;
        market.max = authLimits.max;
      }
    }
  } catch (err) {
    logger.warn(
      "NWSportsbook",
      `limits overlay failed for event ${providerEventId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}


const adapterInstance = new NineWicketsSportsbookAtomsAdapter();


export async function fetchAndStoreNwSportsbookOdds(
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
