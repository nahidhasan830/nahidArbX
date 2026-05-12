/**
 * NineWickets Sportsbook Atoms Adapter
 *
 * Fetches sportsbook odds and stores them in the atoms store.
 * Uses 2-step API flow:
 * 1. Catalog request (version=0) - get market structure
 * 2. Odds request (with marketIds) - get actual odds
 *
 * Dynamically maps ALL markets that match our atoms registry.
 */

import { z } from "zod";
import { BaseAtomsAdapter, type FetchContext } from "./base";
import { buildOddsEntry } from "../../shared/odds-entry";
import { validateAndParse } from "../../shared/validation";
import { createProviderClient } from "../../shared/http";
import type { NormalizedOddsEntry, ProviderKey } from "../types";
import { mapSportsbookToAtom } from "../mappings/ninewickets-sportsbook";
import { setMarketLimits } from "../market-limits-store";
import {
  callWithSessionRetry,
  SessionExpiredError,
} from "../../betting/ninewickets/client";
import { logger } from "../../shared/logger";

// ============================================
// Constants
// ============================================

const PROVIDER: ProviderKey = "ninewickets-sportsbook";
const ENDPOINT_URL =
  "https://gakvx.seofmi.live/exchange/member/playerService/queryGeniusSportsEvent";

// ============================================
// URL Params Helpers
// ============================================

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

// ============================================
// Axios Client
// ============================================

const client = createProviderClient({
  contentType: "form-urlencoded",
  timeout: 5000,
});

// ============================================
// Zod Schemas
// ============================================

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
  // Per-market stake limits exposed by the book. Captured here so the
  // placement modal can surface them without a second HTTP round-trip.
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

// ============================================
// Combined Result Type (for 2-step flow)
// ============================================

interface SportsbookRawData {
  markets: SportsbookMarket[];
  homeTeam: string;
  awayTeam: string;
}

// ============================================
// Adapter Class
// ============================================

export class NineWicketsSportsbookAtomsAdapter extends BaseAtomsAdapter {
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
  ): Promise<SportsbookRawData | null> {
    // Step 1: Fetch catalog
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

    // Include all markets regardless of live flag — some market types
    // (team totals, team corners) only exist as pre-match even during
    // live events. The apiSiteStatus check in extractOdds already
    // handles suspended/closed markets correctly.
    const markets = allMarkets;

    // Step 2: Fetch odds
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

    // The public odds fetch above returns guest-tier min/max. The book
    // issues DIFFERENT per-account limits for the same markets — so to
    // get real, actionable stake windows we piggyback a single
    // authenticated call onto this same cycle and overlay those limits
    // onto the markets we're about to extract from. One session-backed
    // round-trip per event, per sync cycle.
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
    const entries: NormalizedOddsEntry[] = [];
    const timestamp = Date.now();

    for (const market of data.markets) {
      const selections = market.geniusSportsSelection;
      if (!selections || selections.length === 0) continue;

      // Check if market is suspended or closed
      const isSuspended =
        market.apiSiteStatus && market.apiSiteStatus !== "OPEN";

      // Collect entries per market to detect atom collisions before storing
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

        // Collision detection: two selections mapping to the same atom
        // is always a mapping bug (e.g. fuzzy matching failure)
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

      // Skip entire market on collision — all entries are suspect
      if (hasCollision) continue;

      for (const entry of marketEntries) {
        entries.push(entry);
        // Piggyback: record the containing market's stake limits keyed
        // by (provider, event, atom). The UI uses this directly — no
        // second call to the book.
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

// ============================================
// Authenticated limits overlay
// ============================================

/**
 * Overlay account-tier min/max onto markets in place.
 *
 * The unauthenticated catalog fetch above returns guest-tier stake
 * limits (typically a $1 min, low max). 9W issues DIFFERENT per-account
 * limits via the same endpoint when hit with a valid session. We make
 * one authenticated call per event per sync cycle, parse the `min`/
 * `max` from each market, and overwrite the market objects in place so
 * the downstream `extractOdds` stashes the correct values.
 *
 * Runs best-effort: if the session is missing or the auth call fails
 * we silently fall through and the guest-tier limits remain. Odds
 * ingestion is never blocked by limits overlay.
 */
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
    // Best-effort — guest-tier limits remain in place. But log once so
    // we can tell when the overlay is silently failing.
    logger.warn(
      "NWSportsbook",
      `limits overlay failed for event ${providerEventId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ============================================
// Singleton instance
// ============================================

const adapterInstance = new NineWicketsSportsbookAtomsAdapter();

// ============================================
// Legacy Function Exports (Backward Compatibility)
// ============================================

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
