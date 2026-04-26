/**
 * Velki PROVIDER-tier events/odds client.
 *
 * Two functional sub-hosts on the provider tier:
 *   • saapipl.fwick7ets.xyz   — account/player operations (queryPlayerInfo,
 *                               place bets later) → see [client.ts](./client.ts)
 *   • bkqawscf.fwick7ets.xyz  — events / markets / odds catalogue (this file)
 *
 * Both use the SAME JSESSIONID auth captured by session.ts; the split is
 * just operational (different load-balancer pools).
 *
 * Endpoints implemented here:
 *   • POST /exchange/member/playerService/queryEventsWithMarket
 *       Paginated fixtures list (eventType=1 for football, 30/page).
 *       Each event includes its top-level Exchange MATCH_ODDS market.
 *   • POST /exchange/member/playerService/queryGeniusSportsEvent
 *       Sportsbook (Genius Sports) market catalogue + odds for one event.
 *       2-step flow: catalog (version=0) → odds (with marketIds + version).
 *       NOTE: Velki uses apiSiteType=4 (NW Sportsbook uses 5).
 *
 * Error handling mirrors client.ts: status 1001 / 9999 / "logged off"
 * envelope → VelkiSessionExpiredError → callWithSessionRetry triggers a
 * fresh capture.
 */
import { callWithSessionRetry, VelkiSessionExpiredError } from "./session";
import { toBDT } from "./units";

const EVENTS_HOST = "https://bkqawscf.fwick7ets.xyz";
const PROVIDER_WEB_ORIGIN = "https://www.fwick7ets.xyz";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

function browserHeaders(jsessionid: string): Record<string, string> {
  return {
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
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: jsessionid,
    Cookie: `JSESSIONID=${jsessionid}`,
  };
}

/**
 * POST a form-urlencoded body to the events host using the active
 * session, returning parsed JSON. Throws VelkiSessionExpiredError on
 * any of the known session-dead signals so the retry wrapper kicks in.
 */
async function postJson<T = unknown>(path: string, body: string): Promise<T> {
  return callWithSessionRetry(async (session) => {
    const url = `${EVENTS_HOST}${path};jsessionid=${session.jsessionid}`;
    const res = await fetch(url, {
      method: "POST",
      headers: browserHeaders(session.jsessionid),
      body,
    });
    if (res.status === 401 || res.status === 403) {
      throw new VelkiSessionExpiredError(`${path} HTTP ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(`[Velki] ${path} HTTP ${res.status}`);
    }
    const text = (await res.text()).trim();
    if (text.startsWith("<")) {
      throw new VelkiSessionExpiredError(`${path} returned HTML`);
    }
    if (text.length === 0) {
      throw new VelkiSessionExpiredError(`${path} returned empty body`);
    }
    const parsed = JSON.parse(text) as unknown;
    // Error-envelope sniff: status 1001 / 9999 / status_msg "logged off"
    const statusVal = (parsed as { status?: unknown }).status;
    if (
      (typeof statusVal === "string" && statusVal !== "0") ||
      typeof statusVal === "number"
    ) {
      const env = parsed as {
        status: string | number;
        desc?: string;
        message?: string;
        status_msg?: string;
      };
      const code = String(env.status);
      const msg = (
        env.desc ??
        env.message ??
        env.status_msg ??
        ""
      ).toLowerCase();
      if (
        code === "1001" ||
        code === "9999" ||
        msg.includes("not authorized") ||
        msg.includes("logged off")
      ) {
        throw new VelkiSessionExpiredError(
          `${path} session lost (${code} ${msg})`,
        );
      }
      throw new Error(`[Velki] ${path} error envelope: ${code} ${msg}`);
    }
    return parsed as T;
  });
}

// ============================================================
// queryEventsWithMarket — paginated fixtures
// ============================================================

/** One event from queryEventsWithMarket. */
export interface VelkiEventListEntry {
  /** Top-level event ID (note: this field is `id`, not `eventId`). */
  id: number;
  eventType: number;
  competitionId: number;
  competitionName: string;
  countryCode?: string;
  /** Format: "Team A v Team B" — same as 9W. */
  name: string;
  status: number;
  scores?: string; // JSON-string blob
  /** Top-level Exchange market summary (MATCH_ODDS, etc.). */
  markets?: Array<{
    eventType: number;
    eventId: number;
    marketId: string;
    marketType: string;
    marketName: string;
    marketDateTime?: number;
    inPlay?: number;
  }>;
  // Other fields exist (isManualEvent, endPointType, etc.) but we only
  // use what we need to normalize.
}

export interface VelkiEventsPage {
  events: VelkiEventListEntry[];
  eventType: number;
  eventTs: number;
  marketTs: number;
  selectionTs: number;
  lastPage: number;
  currentPage: number;
  gameProductStatus: number;
}

/**
 * Fetch fixtures. Two modes:
 *   - `pageNumber >= 1`  → returns one page (30 events) with paging metadata.
 *   - `pageNumber = -1`  → returns ALL events in a single response (verified
 *     empirically — currentPage=-1, lastPage=0 in this mode). Same as
 *     omitting the param entirely. Preferred for full-list fetches; saves
 *     ~9 round-trips compared to walking 30-event pages.
 *
 * eventType=1 is football.
 */
export async function queryEventsWithMarket(
  pageNumber: number,
  eventType = 1,
): Promise<VelkiEventsPage> {
  const body = new URLSearchParams({
    eventType: String(eventType),
    eventTs: "-1",
    marketTs: "-1",
    selectionTs: "-1",
    viewType: "openDateTime",
    competitionId: "-1",
    pageNumber: String(pageNumber),
  });
  return postJson<VelkiEventsPage>(
    "/exchange/member/playerService/queryEventsWithMarket",
    body.toString(),
  );
}

/**
 * Fetch all fixtures for a sport in a single request via the
 * `pageNumber=-1` "no pagination" mode. The platform returns the full
 * unpaginated list (verified: ~250 events in one call). No walking.
 */
export async function fetchAllEvents(
  eventType = 1,
): Promise<VelkiEventListEntry[]> {
  const result = await queryEventsWithMarket(-1, eventType);
  return result.events;
}

// ============================================================
// queryGeniusSportsEvent — sportsbook market catalogue + odds
// ============================================================

export interface VelkiSportsbookSelection {
  /**
   * Genius Sports INTERNAL selection id. THIS is what goes into the
   * placement payload's `selectionId`. Numeric. Sister deployments use
   * the same id namespace as 9W — confirmed empirically.
   *
   * NOT the same as `apiSiteSelectionId` (the exchange-side id), which
   * the Genius Sports placement endpoint silently rejects with
   * "Selection is Close!".
   */
  id?: number;
  selectionName: string;
  odds: number;
  handicap?: number;
  isActive: boolean | number;
  /** Exchange-side selection id, stringly-typed. Debug-only. */
  apiSiteSelectionId?: string;
}

export interface VelkiSportsbookMarket {
  /** Internal Genius Sports market id (string). */
  id: string;
  marketName: string;
  apiSiteMarketType?: number;
  apiSiteMarketId?: string;
  apiSiteStatus?: string; // "OPEN", "SUSPENDED", "CLOSED"
  selectionTs?: number;
  marketLive?: number;
  betfairEventId?: number;
  /** Per-market stake limits exposed by the book. */
  min?: number;
  max?: number;
  geniusSportsSelection?: VelkiSportsbookSelection[];
}

export interface VelkiGeniusSportsEvent {
  /** Genius Sports internal event id (NOT the Exchange one). */
  eventId: number;
  /** apiSite (Genius Sports vendor) event id. */
  apiSiteEventId?: string;
  eventType: number;
  eventName: string;
  eventStatus?: number;
  live?: boolean;
  min?: number;
  max?: number;
  highlightMarketId?: string;
  competitionId?: number;
  geniusSportsMarkets?: VelkiSportsbookMarket[];
  hasGeniusSportsMarket?: boolean;
  version?: number;
}

/**
 * Scale per-market and per-event stake limits from Velki-units to
 * plain BDT. Mutates a copy of the event so the original wire object
 * stays untouched. See ./units.ts for the convention.
 */
function normalizeAmountsOnEvent(
  ev: VelkiGeniusSportsEvent,
): VelkiGeniusSportsEvent {
  return {
    ...ev,
    min: toBDT(ev.min),
    max: toBDT(ev.max),
    geniusSportsMarkets: ev.geniusSportsMarkets?.map((m) => ({
      ...m,
      min: toBDT(m.min),
      max: toBDT(m.max),
    })),
  };
}

/**
 * Step 1 of the 2-step flow — catalog request with version=0 returns
 * the full market list (no live odds yet, just structure + version).
 */
export async function queryGeniusSportsCatalog(
  exchangeEventId: string,
): Promise<VelkiGeniusSportsEvent> {
  const body = new URLSearchParams({
    eventId: exchangeEventId,
    apiSiteType: "4", // 4 for Velki, 5 for NW (different deployments)
    version: "0",
    marketIds: ",",
    selectionTsList: ",",
    isDynamicUpdate: "0",
  });
  const raw = await postJson<VelkiGeniusSportsEvent>(
    "/exchange/member/playerService/queryGeniusSportsEvent",
    body.toString(),
  );
  return normalizeAmountsOnEvent(raw);
}

/**
 * Step 2 — fetch live odds for a previously-catalogued set of markets.
 * `version` and `selectionTsList` come from the catalog response so the
 * platform knows the client's last-seen state.
 */
export async function queryGeniusSportsOdds(
  exchangeEventId: string,
  version: number,
  marketIds: string[],
  selectionTsList: number[],
): Promise<VelkiGeniusSportsEvent> {
  const body = new URLSearchParams({
    eventId: exchangeEventId,
    apiSiteType: "4",
    version: String(version),
    marketIds: marketIds.join(",") + ",",
    selectionTsList: selectionTsList.join(",") + ",",
    isDynamicUpdate: "1",
  });
  const raw = await postJson<VelkiGeniusSportsEvent>(
    "/exchange/member/playerService/queryGeniusSportsEvent",
    body.toString(),
  );
  return normalizeAmountsOnEvent(raw);
}
