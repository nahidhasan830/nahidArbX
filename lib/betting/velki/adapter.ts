import { callWithSessionRetry, VelkiSessionExpiredError } from "./session";
import { mapSportsbookToAtom } from "@/lib/atoms/mappings/velki-sportsbook";
import {
  queryGeniusSportsCatalog,
  queryGeniusSportsOdds,
} from "./events-client";
import { readPlayerInfoWithRecapture } from "./balance";
import { toBDT, VELKI_AMOUNT_SCALE } from "./units";
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

const PROVIDER_API_HOST = "https://saapipl.fwick7ets.xyz";
const PROVIDER_WEB_ORIGIN = "https://www.fwick7ets.xyz";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: PROVIDER_WEB_ORIGIN,
  Referer: `${PROVIDER_WEB_ORIGIN}/`,
  "sec-ch-ua": '"Chromium";v="147", "Not.A/Brand";v="8", "Brave";v="147"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-site",
  source: "1",
};

export const velkiSportsbookBettingAdapter: BettingProviderAdapter = {
  providerId: "velki-sportsbook",
  providerDisplayName: "Velki Sportsbook",
  currency: "BDT",

  async getAccountInfo(): Promise<AccountInfo> {
    const { info } = await readPlayerInfoWithRecapture();
    return {
      balance: info.betCredit,
      exposure: info.totalExposure,
      minBet: info.minBet,
      suspended:
        Boolean(info.accountSuspended) || Boolean(info.accountSysSuspended),
      currency: "BDT",
    };
  },

  async getMarketLimits(
    providerRefs: Record<string, string | number>,
  ): Promise<MarketLimits | null> {
    const marketId = str(providerRefs, "marketId");
    const eventId = str(providerRefs, "eventId");
    if (!marketId || !eventId) return null;

    try {
      const catalog = await queryGeniusSportsCatalog(eventId);
      const markets = catalog.geniusSportsMarkets ?? [];
      const target = markets.find((m) => m.id === marketId);
      if (
        !target ||
        typeof target.min !== "number" ||
        typeof target.max !== "number"
      ) {
        return null;
      }
      return {
        minBetAmount: target.min,
        maxBetAmount: target.max,
      };
    } catch (err) {
      logger.warn(
        "Velki.getMarketLimits",
        `failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  },

  async resolveProviderRefs(
    input: ResolveRefsInput,
  ): Promise<Record<string, string | number> | null> {
    const event = getEvent(input.normalizedEventId);
    const nativeEventId =
      event?.providers?.["velki-sportsbook"]?.eventId ?? null;
    if (!nativeEventId) {
      logger.warn(
        "Velki.resolveProviderRefs",
        `no native eventId for ${input.normalizedEventId}`,
      );
      return null;
    }

    const eventType = sportToEventType(input.sport);
    let catalog;
    try {
      catalog = await queryGeniusSportsCatalog(nativeEventId);
    } catch (err) {
      logger.warn(
        "Velki.resolveProviderRefs",
        `catalog fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    const catalogMarkets = catalog.geniusSportsMarkets ?? [];
    if (catalogMarkets.length === 0) return null;
    if (typeof catalog.eventId !== "number") {
      logger.warn(
        "Velki.resolveProviderRefs",
        `catalog missing geniusSportsEventId for ${nativeEventId}`,
      );
      return null;
    }

    let oddsData;
    try {
      oddsData = await queryGeniusSportsOdds(
        nativeEventId,
        catalog.version ?? 0,
        catalogMarkets.map((m) => m.id),
        catalogMarkets.map((m) => m.selectionTs ?? -1),
      );
    } catch (err) {
      logger.warn(
        "Velki.resolveProviderRefs",
        `odds fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    const markets = oddsData.geniusSportsMarkets ?? catalogMarkets;
    for (const market of markets) {
      const selections = market.geniusSportsSelection ?? [];
      for (const selection of selections) {
        const atomId = mapSportsbookToAtom(
          market.apiSiteMarketType ?? 0,
          selection.selectionName,
          market.marketName,
          input.homeTeam,
          input.awayTeam,
        );
        if (!atomId || atomId !== input.atomId) continue;

        const selectionRecord = selection as unknown as {
          id?: number;
          handicap?: number;
        };
        if (typeof selectionRecord.id !== "number") continue;
        return {
          apiSiteType: 4,
          eventType,
          eventId: String(catalog.eventId),
          marketId: market.id,
          selectionId: selectionRecord.id,
          handicap: selectionRecord.handicap ?? 0,
          betfairEventId: Number(nativeEventId),
        };
      }
    }

    logger.warn(
      "Velki.resolveProviderRefs",
      `no selection matched atomId=${input.atomId} in event ${nativeEventId}`,
    );
    return null;
  },

  async placeBet(req: PlaceBetRequest): Promise<PlaceBetResult> {
    const stakeWire = Number((req.stake / VELKI_AMOUNT_SCALE).toFixed(4));

    const payloadItem = {
      apiSiteType: num(req.providerRefs, "apiSiteType", 4),
      eventType: str(req.providerRefs, "eventType", "1"),
      eventId: str(req.providerRefs, "eventId"),
      marketId: str(req.providerRefs, "marketId"),
      selectionId: num(req.providerRefs, "selectionId"),
      odds: req.odds,
      stake: stakeWire,
      betfairEventId: num(req.providerRefs, "betfairEventId", 0),
      handicap: num(req.providerRefs, "handicap", 0),
    };

    const params = new URLSearchParams();
    params.set("apiSiteType", String(payloadItem.apiSiteType));
    params.set("geniusSportsBets", JSON.stringify([payloadItem]));
    params.set("voucherId", "");
    params.set("isOneClickBet", "0");

    let requestSnapshot: Record<string, unknown> | null = null;

    try {
      return await callWithSessionRetry(async (session) => {
        const url = `${PROVIDER_API_HOST}/exchange/member/playerService/geniusSportsBet;jsessionid=${session.jsessionid}`;
        requestSnapshot = {
          url,
          body: params.toString(),
          payloadItem,
        };

        const res = await fetch(url, {
          method: "POST",
          headers: {
            ...BROWSER_HEADERS,
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: session.jsessionid,
            Cookie: `JSESSIONID=${session.jsessionid}`,
          },
          body: params.toString(),
        });

        if (res.status === 401 || res.status === 403) {
          throw new VelkiSessionExpiredError(`placeBet ${res.status}`);
        }

        const text = await res.text();
        const trimmed = text.trim();
        if (trimmed.startsWith("<")) {
          throw new VelkiSessionExpiredError("placeBet returned HTML");
        }
        if (trimmed.length === 0) {
          throw new VelkiSessionExpiredError("placeBet returned empty body");
        }

        const parsed = JSON.parse(trimmed) as ParsedBetResponse;
        return interpretBetResponse(parsed, req.odds, requestSnapshot);
      });
    } catch (err) {
      if (err instanceof VelkiSessionExpiredError) {
        return {
          status: "error",
          request: requestSnapshot,
          response: null,
          error:
            "Auth failure persisted after re-login. Check Velki credentials or auto-login state.",
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
  unMatchTicket?: { id?: string | number } | null;
  txn?: { id?: string | number; betId?: string | number } | null;
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
    result.ticketId ??
    result.orderId ??
    result.betId ??
    result.id ??
    result.unMatchTicket?.id ??
    result.txn?.betId ??
    result.txn?.id;
  const isPendingFlag = Boolean(result.isPending ?? result.pending);

  if (rawStatus === "SUCCESS" && ticketId !== undefined) {
    return {
      status: "placed",
      ticketId: String(ticketId),
      bookedOdds: result.odds ?? requestedOdds,
      request: requestSnapshot,
      response: parsed,
    };
  }

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

  const rawError =
    result.error ?? result.message ?? result.errorCode ?? rawStatus;
  return {
    status: "rejected",
    request: requestSnapshot,
    response: parsed,
    error: humanizeBookError(rawError),
  };
}

function humanizeBookError(raw: string | undefined | null): string {
  if (!raw) return "Bet rejected by bookmaker (no reason given).";
  const msg = String(raw).trim();
  if (!msg) return "Bet rejected by bookmaker (no reason given).";
  const upper = msg.toUpperCase();

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
  if (upper.includes("ACCOUNT_SUSPEND") || upper.includes("USER_SUSPEND")) {
    return "Account is suspended by the bookmaker.";
  }
  if (
    upper.includes("FAIL") ||
    upper.includes("ERROR") ||
    upper.includes("REJECT")
  ) {
    return `Book rejected bet: ${msg}`;
  }
  return `Book rejected bet: ${msg}`;
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

function sportToEventType(sport?: string): string {
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

export { toBDT };
