/**
 * SABA direct events client.
 *
 * Browser discovery showed the sportsbook uses a provider-side token chain:
 *   1. POST ApiSiteLogin/ReGenerateToken             -> SABA API token
 *   2. GET  Config/GetBeforeOddsServerConfig         -> odds host/token
 *   3. POST BFOdds/ShowAllOdds (GameId=1, DateType)  -> soccer fixtures
 *
 * This client intentionally uses plain fetch only. Playwright stays confined
 * to the login/session capture path.
 */

import { getSession } from "./session";

const SABA_WEB_ORIGIN = "https://l9y4gp.bpah3tqv.com";
const SABA_API_ORIGIN = "https://l9y4mi.bpah3tqv.com";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const BASE_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: SABA_WEB_ORIGIN,
  Referer: `${SABA_WEB_ORIGIN}/`,
};

export type SabaDateType = "e" | "t" | "l";

export interface SabaOddsConfig {
  oddsServerUrl: string;
  oddsServerToken: string;
}

export interface SabaMatch {
  MatchId: number;
  MatchCode?: string;
  GameID: number;
  LeagueId: number;
  LeagueGroupId: number;
  TeamId1: number;
  TeamId2: number;
  Ktm?: string;
  Etm?: string;
  GameTime?: string;
  ShowTime?: string;
  MaT?: string;
  IsLive?: boolean;
  hasLive?: boolean;
  MarketCount?: number;
}

export interface SabaShowAllOddsData {
  TeamN?: Record<string, string>;
  LeagueN?: Record<string, string>;
  NewMatch?: SabaMatch[];
  NewMatchCount?: number;
}

interface SabaTokenResponse {
  Data?: {
    Token?: string;
  };
}

interface SabaBeforeOddsConfigResponse {
  Data?: {
    OddsServerUrl?: string;
    OddsServerToken?: string;
  };
}

interface SabaShowAllOddsResponse {
  ErrorCode?: number;
  ErrorMsg?: string;
  Data?: SabaShowAllOddsData;
}

function assertJsonResponse(
  label: string,
  text: string,
): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<")) {
    throw new Error(`[SABA] ${label} returned non-JSON response`);
  }
  return JSON.parse(trimmed) as Record<string, unknown>;
}

async function fetchJson<T>(
  label: string,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`[SABA] ${label} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return assertJsonResponse(label, text) as T;
}

export async function getSabaApiToken(): Promise<string> {
  // Ensure the BetConstruct login/session path has run. The SABA provider API
  // currently mints the API token without sending the main access token, but
  // this keeps auth state fresh and fails early when credentials are missing.
  await getSession();

  const body = {
    isBefore: true,
    isExtend: false,
    Lang: "en-US",
    GalaxyUserServerGroup: "",
  };
  const json = await fetchJson<SabaTokenResponse>(
    "ApiSiteLogin/ReGenerateToken",
    `${SABA_API_ORIGIN}/api/ApiSiteLogin/ReGenerateToken`,
    {
      method: "POST",
      headers: {
        ...BASE_HEADERS,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  const token = json.Data?.Token;
  if (!token) {
    throw new Error("[SABA] ReGenerateToken response did not include Data.Token");
  }
  return token;
}

export async function getSabaOddsConfig(): Promise<SabaOddsConfig> {
  const token = await getSabaApiToken();
  const json = await fetchJson<SabaBeforeOddsConfigResponse>(
    "Config/GetBeforeOddsServerConfig",
    `${SABA_API_ORIGIN}/api/Config/GetBeforeOddsServerConfig`,
    {
      headers: {
        ...BASE_HEADERS,
        Authorization: `Bearer ${token}`,
      },
    },
  );

  const oddsServerUrl = json.Data?.OddsServerUrl;
  const oddsServerToken = json.Data?.OddsServerToken;
  if (!oddsServerUrl || !oddsServerToken) {
    throw new Error(
      "[SABA] GetBeforeOddsServerConfig response did not include odds config",
    );
  }
  return { oddsServerUrl, oddsServerToken };
}

export async function fetchSoccerShowAllOdds(
  dateType: SabaDateType,
): Promise<SabaShowAllOddsData> {
  const config = await getSabaOddsConfig();
  const form = new FormData();
  form.set("GameId", "1");
  form.set("DateType", dateType);

  const json = await fetchJson<SabaShowAllOddsResponse>(
    `BFOdds/ShowAllOdds dateType=${dateType}`,
    `https://${config.oddsServerUrl}/BFOdds/ShowAllOdds`,
    {
      method: "POST",
      headers: {
        ...BASE_HEADERS,
        Authorization: `Bearer ${config.oddsServerToken}`,
        _mculture: "en-US",
      },
      body: form,
    },
  );

  if (json.ErrorCode !== 0) {
    throw new Error(
      `[SABA] ShowAllOdds failed: ${json.ErrorCode} ${json.ErrorMsg ?? ""}`,
    );
  }
  return json.Data ?? {};
}

export async function fetchRealSoccerEvents(): Promise<{
  upcoming: SabaShowAllOddsData;
  today: SabaShowAllOddsData;
  live: SabaShowAllOddsData;
}> {
  const [upcoming, today, live] = await Promise.all([
    fetchSoccerShowAllOdds("e"),
    fetchSoccerShowAllOdds("t"),
    fetchSoccerShowAllOdds("l"),
  ]);
  return { upcoming, today, live };
}
