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

async function postJson<T = unknown>(path: string, body: string): Promise<T> {
  return callWithSessionRetry(async (session) => {
    const url = `${EVENTS_HOST}${path};jsessionid=${session.jsessionid}`;
    const res = await fetch(url, {
      method: "POST",
      headers: browserHeaders(session.jsessionid),
      body,
    });
    if (res.status === 401 || res.status === 403 || res.status === 410) {
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


export interface VelkiEventListEntry {
  id: number;
  eventType: number;
  competitionId: number;
  competitionName: string;
  countryCode?: string;
  name: string;
  status: number;
  scores?: string;
  markets?: Array<{
    eventType: number;
    eventId: number;
    marketId: string;
    marketType: string;
    marketName: string;
    marketDateTime?: number;
    inPlay?: number;
  }>;
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

export async function fetchAllEvents(
  eventType = 1,
): Promise<VelkiEventListEntry[]> {
  const result = await queryEventsWithMarket(-1, eventType);
  return result.events;
}


export interface VelkiSportsbookSelection {
  id?: number;
  selectionName: string;
  odds: number;
  handicap?: number;
  isActive: boolean | number;
  apiSiteSelectionId?: string;
}

export interface VelkiSportsbookMarket {
  id: string;
  marketName: string;
  apiSiteMarketType?: number;
  apiSiteMarketId?: string;
  apiSiteStatus?: string;
  selectionTs?: number;
  marketLive?: number;
  betfairEventId?: number;
  min?: number;
  max?: number;
  geniusSportsSelection?: VelkiSportsbookSelection[];
}

export interface VelkiGeniusSportsEvent {
  eventId: number;
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

export async function queryGeniusSportsOdds(
  exchangeEventId: string,
  version: number,
  marketIds: string[],
  selectionTsList: number[],
  isDynamicUpdate = false,
): Promise<VelkiGeniusSportsEvent> {
  const body = new URLSearchParams({
    eventId: exchangeEventId,
    apiSiteType: "4",
    version: String(version),
    marketIds: marketIds.join(",") + ",",
    selectionTsList: selectionTsList.join(",") + ",",
    isDynamicUpdate: isDynamicUpdate ? "1" : "0",
  });
  const raw = await postJson<VelkiGeniusSportsEvent>(
    "/exchange/member/playerService/queryGeniusSportsEvent",
    body.toString(),
  );
  return normalizeAmountsOnEvent(raw);
}
