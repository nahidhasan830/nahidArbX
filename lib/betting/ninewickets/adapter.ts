/**
 * 9W Sportsbook adapter. Translates the provider-agnostic
 * {@link BettingProviderAdapter} contract into the concrete
 * gakqv/gakvx.seofmi.live endpoints.
 *
 * `providerRefs` expected by placeBet / getMarketLimits:
 *   - apiSiteType      (number, 5 for sportsbook)
 *   - eventType        (string, e.g. "1" for soccer)
 *   - eventId          (string)
 *   - marketId         (string)
 *   - selectionId      (number)
 *   - betfairEventId?  (number, optional — included when available)
 *   - handicap?        (number)
 */
import { getSession, invalidateSession } from "./session";
import {
  queryPlayerInfo,
  callWithSessionRetry,
  SessionExpiredError,
} from "./client";
import { mapSportsbookToAtom } from "@/lib/atoms/mappings/ninewickets-sportsbook";
import { getEvent } from "@/lib/store";
import { logger } from "@/lib/shared/logger";
import type {
  AccountInfo,
  BettingProviderAdapter,
  MarketLimits,
  PlaceBetRequest,
  PlaceBetResult,
  ResolveRefsInput,
} from "../types";

const HOST_WRITE = "https://gakqv.seofmi.live";
const HOST_READ = "https://gakvx.seofmi.live";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

// The write host (gakqv.seofmi.live) silently rejects requests whose
// Origin/Referer don't match the 9wktsbest frontend — it returns HTTP
// 200 with an empty body AND a Set-Cookie that wipes JSESSIONID. Send
// the full browser-equivalent header set so the WAF accepts us. The
// read host seems to be more lenient but we send the same for
// consistency.
const BROWSER_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://9wktsbest.com",
  Referer: "https://9wktsbest.com/",
  "sec-ch-ua": '"Chromium";v="147", "Not.A/Brand";v="8", "Brave";v="147"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
} as const;

export const ninewicketsSportsbookAdapter: BettingProviderAdapter = {
  providerId: "ninewickets-sportsbook",
  providerDisplayName: "9W Sportsbook",
  currency: "BDT",

  async getAccountInfo(): Promise<AccountInfo> {
    const info = await queryPlayerInfo();
    return {
      balance: info.betCredit,
      exposure: info.totalExposure,
      minBet: info.minBet,
      suspended:
        Boolean(info.accountSuspended) ||
        Boolean(info.accountSysSuspended) ||
        Boolean(info.accountVoidSuspended),
      currency: "BDT",
    };
  },

  async getMarketLimits(
    providerRefs: Record<string, string | number>,
  ): Promise<MarketLimits | null> {
    const apiSiteType = num(providerRefs, "apiSiteType", 5);
    const eventType = str(providerRefs, "eventType", "1");
    const eventId = str(providerRefs, "eventId");
    const marketId = str(providerRefs, "marketId");

    if (!eventId || !marketId) return null;

    return callWithSessionRetry(async (session) => {
      const url = `${HOST_READ}/exchange/member/playerService/queryGeniusSportsEvent;jsessionid=${session.queryPass}`;
      // The bare catalog call (no version/marketIds) returns market
      // shells without min/max. Sending the same params the odds-ingest
      // overlay uses forces 9W to include per-market stake limits for
      // this account's tier. Without them extractLimits returns null
      // and the placer falls back to accountInfo.minBet (~1 BDT) — far
      // below the real market min, which then gets rejected by the book.
      const params = new URLSearchParams();
      params.set("apiSiteType", String(apiSiteType));
      params.set("eventType", eventType);
      params.set("eventId", eventId);
      params.set("version", "0");
      params.set("marketIds", ",");
      params.set("selectionTsList", ",");
      params.set("isDynamicUpdate", "0");

      const res = await fetch(url, {
        method: "POST",
        headers: {
          ...BROWSER_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: session.queryPass,
        },
        body: params.toString(),
      });

      if (res.status === 401 || res.status === 403) {
        throw new SessionExpiredError(`getMarketLimits ${res.status}`);
      }
      if (!res.ok) return null;

      const text = await res.text();
      if (text.trim().startsWith("<")) {
        throw new SessionExpiredError("getMarketLimits returned HTML");
      }
      const body = JSON.parse(text) as unknown;
      return extractLimits(body, marketId);
    }).catch(() => null);
  },

  async resolveProviderRefs(
    input: ResolveRefsInput,
  ): Promise<Record<string, string | number> | null> {
    const event = getEvent(input.normalizedEventId);
    const nativeEventId =
      event?.providers?.["ninewickets-sportsbook"]?.eventId ??
      event?.providers?.["ninewickets-exchange"]?.eventId ??
      null;
    if (!nativeEventId) {
      logger.warn(
        "NWSB.resolveProviderRefs",
        `no native eventId for ${input.normalizedEventId}`,
      );
      return null;
    }

    const eventType = sportToEventType(input.sport);
    const catalog = await fetchEventCatalog(nativeEventId);
    if (!catalog) return null;
    if (catalog.geniusSportsEventId === null) {
      logger.warn(
        "NWSB.resolveProviderRefs",
        `catalog missing geniusSportsEventId for ${nativeEventId}`,
      );
      return null;
    }

    // Walk markets/selections calling the same mapping the odds adapter
    // uses at ingest time. When the mapping reproduces our (familyId,
    // atomId) we have our target.
    for (const market of catalog.markets) {
      const selections = market.geniusSportsSelection ?? [];
      for (const selection of selections) {
        const atomId = mapSportsbookToAtom(
          market.apiSiteMarketType,
          selection.selectionName,
          market.marketName,
          input.homeTeam,
          input.awayTeam,
        );
        if (!atomId || atomId !== input.atomId) continue;

        // IMPORTANT — id mapping (learned the hard way, placements
        // silently fail with "Selection is Close!" when wrong):
        //   - payload.eventId      = catalog.eventId         (GS id)
        //   - payload.marketId     = market.id               (GS id)
        //   - payload.selectionId  = selection.id            (GS id,
        //                             NOT apiSiteSelectionId)
        //   - payload.betfairEventId = exchange id we looked up by
        // The `apiSite*` fields are exchange-side ids and are
        // rejected by the placement endpoint. See comments on
        // CatalogSelection and [types.ts](./types.ts#GeniusSportsBetPayload).
        return {
          apiSiteType: 5,
          eventType,
          eventId: String(catalog.geniusSportsEventId),
          marketId: market.id,
          selectionId: selection.id,
          handicap: selection.handicap ?? 0,
          betfairEventId: catalog.betfairEventId,
        };
      }
    }

    logger.warn(
      "NWSB.resolveProviderRefs",
      `no selection matched atomId=${input.atomId} in event ${nativeEventId}`,
    );
    return null;
  },

  async placeBet(req: PlaceBetRequest): Promise<PlaceBetResult> {
    const session = await getSession();

    // See GeniusSportsBetPayload in ./types.ts for field semantics.
    // eventId is the Genius Sports internal id, betfairEventId is
    // the exchange id — BOTH are required for placement to succeed.
    const payloadItem = {
      apiSiteType: num(req.providerRefs, "apiSiteType", 5),
      eventType: str(req.providerRefs, "eventType", "1"),
      eventId: str(req.providerRefs, "eventId"),
      marketId: str(req.providerRefs, "marketId"),
      selectionId: num(req.providerRefs, "selectionId"),
      odds: req.odds,
      stake: req.stake,
      betfairEventId: num(req.providerRefs, "betfairEventId", 0),
      handicap: num(req.providerRefs, "handicap", 0),
    };

    const params = new URLSearchParams();
    params.set("apiSiteType", String(payloadItem.apiSiteType));
    params.set("geniusSportsBets", JSON.stringify([payloadItem]));
    params.set("voucherId", "");
    params.set("isOneClickBet", "0");

    let requestSnapshot: any = null;

    try {
      return await callWithSessionRetry(async (session) => {
        const url = `${HOST_WRITE}/exchange/member/playerService/geniusSportsBet;jsessionid=${session.queryPass}`;
        requestSnapshot = {
          url,
          body: params.toString(),
          payloadItem,
        };

        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json, text/plain, */*",
            Authorization: session.queryPass,
            "User-Agent": UA,
          },
          body: params.toString(),
        });

        if (res.status === 401 || res.status === 403) {
          throw new SessionExpiredError(`placeBet ${res.status}`);
        }

        const text = await res.text();
        const trimmed = text.trim();
        if (trimmed.startsWith("<")) {
          throw new SessionExpiredError("placeBet returned HTML");
        }
        if (trimmed.length === 0) {
          // Write host silently rejects requests the WAF dislikes:
          // 200 + empty body + Set-Cookie clearing JSESSIONID. Treat
          // the same as an expired session so we re-login and retry.
          throw new SessionExpiredError("placeBet returned empty body");
        }

        const parsed = JSON.parse(trimmed) as ParsedBetResponse;
        return interpretBetResponse(parsed, req.odds, requestSnapshot);
      });
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        return {
          status: "error",
          request: requestSnapshot,
          response: null,
          error:
            "Auth failure persisted after re-login. Check 9W credentials or network.",
        };
      }
      return {
        status: "error",
        request: requestSnapshot,
        response: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};

// --------------------------------------------------------------------
// Helpers — bet-response interpretation
//
// 9W's geniusSportsBet response is inconsistent. Observed shapes:
//   1. result[0] = { status: "SUCCESS", ticketId, orderId?, odds }
//        → confirmed placement, write to DB.
//   2. result[0] = { status: "SUCCESS" } (no ticket id)
//   2b. result[0] = { status: "PENDING" | "PROCESSING" } or isPending:true
//        → book accepted but is still processing; ticket comes later via
//          myBets polling. Write to DB at outcome='pending'.
//   3. result[0] = { status: "FAIL"/... , error: "BELOW_MIN_STAKE" etc. }
//        → rejection with business reason. Do NOT write to DB.
//   4. No result[] — envelope-level error field or status.
//        → treat as rejection if we can extract a message, else error.
// --------------------------------------------------------------------

interface ParsedBetResult {
  status?: string;
  error?: string;
  errorCode?: string;
  message?: string;
  ticketId?: string | number;
  orderId?: string | number;
  betId?: string | number;
  id?: string | number;
  odds?: number;
  isPending?: boolean;
  pending?: boolean;
}

interface ParsedBetResponse {
  result?: ParsedBetResult[];
  status?: string;
  error?: string;
  message?: string;
}

function interpretBetResponse(
  parsed: ParsedBetResponse,
  requestedOdds: number,
  requestSnapshot: unknown,
): PlaceBetResult {
  const result = parsed.result?.[0];

  if (!result) {
    // Envelope-level error (no result array). If we can surface a
    // message treat as rejection, otherwise generic parse failure.
    const envelopeError = parsed.error ?? parsed.message ?? parsed.status;
    if (envelopeError) {
      return {
        status: "rejected",
        request: requestSnapshot,
        response: parsed,
        error: humanizeBookError(envelopeError),
      };
    }
    return {
      status: "error",
      request: requestSnapshot,
      response: parsed,
      error: "Empty response from book",
    };
  }

  const rawStatus = (result.status ?? "").toUpperCase();
  const ticketId =
    result.ticketId ?? result.orderId ?? result.betId ?? result.id;
  const isPendingFlag = Boolean(result.isPending ?? result.pending);

  // Confirmed — book gave us a ticket id.
  if (rawStatus === "SUCCESS" && ticketId !== undefined) {
    return {
      status: "placed",
      ticketId: String(ticketId),
      bookedOdds: result.odds ?? requestedOdds,
      request: requestSnapshot,
      response: parsed,
    };
  }

  // Accepted-but-processing. Ticket will arrive asynchronously.
  if (
    rawStatus === "SUCCESS" ||
    rawStatus === "PENDING" ||
    rawStatus === "PROCESSING" ||
    rawStatus === "ACCEPTED" ||
    isPendingFlag
  ) {
    return {
      status: "pending",
      ticketId: ticketId !== undefined ? String(ticketId) : undefined,
      bookedOdds: result.odds ?? requestedOdds,
      request: requestSnapshot,
      response: parsed,
    };
  }

  // Rejection — translate the cryptic book message.
  const rawError =
    result.error ?? result.message ?? result.errorCode ?? rawStatus;
  return {
    status: "rejected",
    request: requestSnapshot,
    response: parsed,
    error: humanizeBookError(rawError),
  };
}

/** Translate 9W's internal error strings into user-friendly messages. */
function humanizeBookError(raw: string | undefined | null): string {
  if (!raw) return "Bet rejected by bookmaker (no reason given).";
  const msg = String(raw).trim();
  if (!msg) return "Bet rejected by bookmaker (no reason given).";
  const upper = msg.toUpperCase();

  // Stake limits — 9W's natural-language messages use phrases like
  // "below the minimum" and "exceed the maximum", not the underscored
  // constant names our first pass expected. Match both.
  if (
    upper.includes("BELOW_MIN") ||
    upper.includes("MIN_STAKE") ||
    upper.includes("MIN_BET") ||
    upper.includes("BELOW THE MINIMUM") ||
    upper.includes("BELOW MINIMUM") ||
    (upper.includes("STAKE") && upper.includes("MINIMUM"))
  ) {
    return "Stake is below the market's minimum.";
  }
  if (
    upper.includes("ABOVE_MAX") ||
    upper.includes("MAX_STAKE") ||
    upper.includes("MAX_BET") ||
    upper.includes("LIMIT_EXCEEDED") ||
    upper.includes("ABOVE THE MAXIMUM") ||
    upper.includes("EXCEED THE MAXIMUM") ||
    (upper.includes("STAKE") && upper.includes("MAXIMUM"))
  ) {
    return "Stake exceeds the market's maximum.";
  }

  // Balance / exposure
  if (
    upper.includes("INSUFFICIENT") ||
    upper.includes("BALANCE") ||
    upper.includes("CREDIT")
  ) {
    return "Insufficient balance to place this bet.";
  }
  if (upper.includes("EXPOSURE")) {
    return "Placing this bet would exceed your exposure limit.";
  }

  // Price / odds drift
  if (
    upper.includes("PRICE_CHAN") ||
    upper.includes("ODDS_CHAN") ||
    upper.includes("PRICE_MOVED")
  ) {
    return "Odds moved before placement — try again with the current price.";
  }
  if (upper.includes("INVALID_ODDS") || upper.includes("BAD_ODDS")) {
    return "Requested odds are not offered by the book.";
  }

  // Market state
  if (upper.includes("SUSPEND")) {
    return "Market is suspended (likely in-play price freeze).";
  }
  if (
    upper.includes("CLOSED") ||
    upper.includes("IS CLOSE") ||
    upper.includes("SETTLED") ||
    upper.includes("EXPIRED")
  ) {
    return "Selection is closed — market locked (event may be in-play or ended).";
  }
  if (
    upper.includes("NOT_FOUND") ||
    upper.includes("INVALID_MARKET") ||
    upper.includes("INVALID_SELECTION")
  ) {
    return "Market or selection no longer exists on the book.";
  }

  // Account state
  if (upper.includes("ACCOUNT_SUSPEND") || upper.includes("USER_SUSPEND")) {
    return "Account is suspended by the bookmaker.";
  }

  // Generic FAIL — include the raw string so ops can trace it.
  if (
    upper.includes("FAIL") ||
    upper.includes("ERROR") ||
    upper.includes("REJECT")
  ) {
    return `Book rejected bet: ${msg}`;
  }
  return `Book rejected bet: ${msg}`;
}

// --------------------------------------------------------------------
// Helpers — extract min/max bet from the Genius Sports event response.
// The response shape is a nested object; we walk it to find an entry
// matching the target marketId and read its limits. If the layout
// doesn't match what we expect, return null — the placer will fall
// back to the account-level minBet.
// --------------------------------------------------------------------
function extractLimits(body: unknown, marketId: string): MarketLimits | null {
  const seen = new WeakSet<object>();
  const visit = (node: unknown): MarketLimits | null => {
    if (!node || typeof node !== "object") return null;
    if (seen.has(node as object)) return null;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = visit(item);
        if (hit) return hit;
      }
      return null;
    }
    const obj = node as Record<string, unknown>;
    const idCandidate = obj.marketId ?? obj.id;
    if (idCandidate !== undefined && String(idCandidate) === marketId) {
      const min = asNumber(obj.minBetAmount ?? obj.minBet ?? obj.min);
      const max = asNumber(obj.maxBetAmount ?? obj.maxBet ?? obj.max);
      // Min alone is enough to protect against below-min rejections;
      // the placer treats a missing max as "no cap" (Infinity).
      if (min !== null) {
        return {
          minBetAmount: min,
          maxBetAmount: max ?? Number.POSITIVE_INFINITY,
        };
      }
    }
    for (const v of Object.values(obj)) {
      const hit = visit(v);
      if (hit) return hit;
    }
    return null;
  };
  return visit(body);
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(
  refs: Record<string, string | number>,
  key: string,
  fallback?: string,
): string {
  const v = refs[key];
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    return "";
  }
  return String(v);
}

function num(
  refs: Record<string, string | number>,
  key: string,
  fallback = 0,
): number {
  const v = refs[key];
  if (v === undefined || v === null) return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// --------------------------------------------------------------------
// Market catalog — shared between resolveProviderRefs and
// getMarketLimits. Two-step fetch (catalog, then odds with marketIds)
// mirrors what the odds-ingest adapter does.
// --------------------------------------------------------------------

interface CatalogSelection {
  /**
   * The Genius Sports INTERNAL selection id — what goes into the
   * placement payload's `selectionId`. Numeric. Sample: 236315253.
   * NOT the same as apiSiteSelectionId.
   */
  id: number;
  selectionName: string;
  odds: number;
  handicap: number;
  isActive: boolean | number;
  /**
   * Exchange-side selection id, stringly typed. NOT used for
   * placement — 9W rejects placements with this id silently
   * ("Selection X is Close!"). Kept for reference / debug.
   */
  apiSiteSelectionId: string;
}

interface CatalogMarket {
  id: string;
  marketName: string;
  apiSiteMarketType: number;
  apiSiteStatus?: string;
  selectionTs?: number;
  live?: boolean;
  geniusSportsSelection?: CatalogSelection[];
  minBetAmount?: number;
  maxBetAmount?: number;
}

interface CatalogResponse {
  /**
   * Genius Sports INTERNAL event id. This is what goes back into
   * `placeBet.eventId`. Confusingly the same field name is used as a
   * REQUEST param meaning "exchange/betfair event id" — server input
   * and server output use the same key for different concepts.
   */
  eventId?: number;
  /**
   * Betfair/exchange event id echoed back. Matches the `nativeEventId`
   * we passed in — this is what goes into `placeBet.betfairEventId`.
   */
  apiSiteEventId?: string | number;
  eventName?: string;
  version?: number;
  live?: boolean;
  geniusSportsMarkets?: CatalogMarket[];
}

interface EventCatalog {
  markets: CatalogMarket[];
  version: number;
  /** Genius Sports internal id — goes into placeBet.eventId. */
  geniusSportsEventId: number | null;
  /** Betfair/exchange id — goes into placeBet.betfairEventId. */
  betfairEventId: number;
}

async function fetchEventCatalog(
  nativeEventId: string,
): Promise<EventCatalog | null> {
  try {
    const session = await getSession();
    const url = `https://gakvx.seofmi.live/exchange/member/playerService/queryGeniusSportsEvent;jsessionid=${session.queryPass}`;
    const catalogParams = new URLSearchParams({
      apiSiteType: "5",
      eventId: nativeEventId,
      version: "0",
      marketIds: ",",
      selectionTsList: ",",
      isDynamicUpdate: "0",
    });
    const catalogRes = await fetch(url, {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: session.queryPass,
      },
      body: catalogParams.toString(),
    });
    if (catalogRes.status === 401 || catalogRes.status === 403) {
      invalidateSession();
      return null;
    }
    if (!catalogRes.ok) return null;
    const catalogText = await catalogRes.text();
    if (catalogText.trim().startsWith("<")) {
      invalidateSession();
      return null;
    }
    const catalog = JSON.parse(catalogText) as CatalogResponse;
    const markets = catalog.geniusSportsMarkets ?? [];
    if (markets.length === 0) return null;

    // Step 2 — fetch odds to populate selections (the catalog alone
    // only returns market shells).
    const marketIds = markets.map((m) => m.id);
    const selectionTsList = markets.map((m) => m.selectionTs ?? -1);
    const version = catalog.version ?? 0;
    const oddsParams = new URLSearchParams({
      apiSiteType: "5",
      eventId: nativeEventId,
      version: String(version),
      marketIds: marketIds.join(",") + ",",
      selectionTsList: selectionTsList.join(",") + ",",
      isDynamicUpdate: "0",
    });
    const oddsRes = await fetch(url, {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: session.queryPass,
      },
      body: oddsParams.toString(),
    });
    if (!oddsRes.ok) return null;
    const oddsText = await oddsRes.text();
    if (oddsText.trim().startsWith("<")) return null;
    const oddsData = JSON.parse(oddsText) as CatalogResponse;
    // Prefer the odds-step response for freshness but fall back to
    // the catalog step for ids (server sometimes omits ids in the
    // odds response).
    const geniusSportsEventId =
      typeof oddsData.eventId === "number"
        ? oddsData.eventId
        : typeof catalog.eventId === "number"
          ? catalog.eventId
          : null;
    return {
      markets: oddsData.geniusSportsMarkets ?? markets,
      version: oddsData.version ?? version,
      geniusSportsEventId,
      betfairEventId: Number(nativeEventId),
    };
  } catch (err) {
    logger.warn(
      "NWSB.fetchEventCatalog",
      `failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function sportToEventType(sport?: string): string {
  // 9W's eventType is a numeric code. Only a few are known empirically;
  // default to "1" (soccer) which covers the vast majority of our bets.
  switch ((sport ?? "").toLowerCase()) {
    case "soccer":
    case "football":
      return "1";
    case "tennis":
      return "2";
    case "basketball":
      return "3";
    case "cricket":
      return "4";
    default:
      return "1";
  }
}
