/**
 * 9W overview — one-shot bundle for the dashboard.
 *
 * Returns everything the /dashboard wallet + turnover + live-bets
 * sections need in a single round trip, so the existing 15s poll
 * picks it up without extra latency.
 *
 *   {
 *     ok: boolean,
 *     at: ISO,
 *     providerInfo: { betCredit, exposure, suspended, minBet, ... } | null,
 *     mainSite: {
 *       withdrawable: number | null,   // totalMainProviderBalance
 *       cashWallet: number | null,     // balance
 *       userName: string | null,
 *       vip: { nowVipName, nowVipPercent, nextVipName } | null,
 *       providerStatuses: ProviderExtraData[],
 *     } | null,
 *     turnover: {
 *       canWithdraw: boolean,
 *       recordsCount: number,
 *       records: TurnoverRecord[],
 *     } | null,
 *     unmatchedTickets: GeniusSportsUnMatchTicket[],
 *     autoLogin: AutoLoginConfig,
 *     reconciled: ReconcileReport | null,
 *     errors: { [key: string]: string },   // partial-failure details
 *   }
 *
 * The route is conservative: any single dependency failing DOES NOT
 * 500 the whole response. We surface the error in `errors[name]`
 * and return null for that slice. This keeps the dashboard alive
 * when, say, the main-site JWT has expired but the provider session
 * is still fine (or vice versa).
 *
 * Reconciliation runs as part of this call — every GET attempts to
 * attach ticket ids to any dangling pending rows.
 */
import { NextResponse } from "next/server";
import { queryPlayerInfo } from "@/lib/betting/ninewickets/client";
import {
  getSession,
  invalidateSession,
} from "@/lib/betting/ninewickets/session";
import {
  getAutoLoginConfig,
  AutoLoginDisabledError,
} from "@/lib/betting/ninewickets/auto-login-config";
import {
  fetchUnMatchedTickets,
  reconcilePendingBets,
  type ReconcileReport,
} from "@/lib/betting/ninewickets/reconciler";
import type {
  MainSitePlayerInfo,
  TurnoverListResponse,
  MainSitePlayerInfoResponse,
} from "@/lib/betting/ninewickets/main-site-types";
import { isMainSiteOk } from "@/lib/betting/ninewickets/main-site-types";
import {
  mainSiteFetchJson,
  MainSiteAuthExpiredError,
} from "@/lib/betting/ninewickets/main-site-client";
import { logger } from "@/lib/shared/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const at = new Date().toISOString();
  const errors: Record<string, string> = {};

  // Run in parallel — each slice is independently resilient.
  const [
    providerInfoResult,
    mainSiteResult,
    turnoverResult,
    unmatchedResult,
    reconciledResult,
  ] = await Promise.allSettled([
    queryPlayerInfo(),
    fetchMainSitePlayerInfo(),
    fetchTurnover(),
    fetchUnMatchedTickets(),
    reconcilePendingBets(),
  ]);

  // --- provider-level player info (betCredit, exposure, suspended) ---
  let providerInfo: {
    betCredit: number;
    exposure: number;
    suspended: boolean;
    minBet: number;
  } | null = null;
  if (providerInfoResult.status === "fulfilled") {
    const info = providerInfoResult.value;
    providerInfo = {
      betCredit: info.betCredit,
      exposure: info.totalExposure,
      suspended:
        Boolean(info.accountSuspended) ||
        Boolean(info.accountSysSuspended) ||
        Boolean(info.accountVoidSuspended),
      minBet: info.minBet,
    };
  } else {
    errors.providerInfo = errMessage(providerInfoResult.reason);
  }

  // --- main-site player info (withdrawable balance, VIP, etc.) ---
  let mainSite: {
    withdrawable: number | null;
    cashWallet: number | null;
    userName: string | null;
    vip: {
      nowVipName: string;
      nowVipPercent: number;
      nextVipName: string;
    } | null;
    providerStatuses: MainSitePlayerInfo["providerExtraData"];
  } | null = null;
  if (mainSiteResult.status === "fulfilled" && mainSiteResult.value) {
    const d = mainSiteResult.value;
    mainSite = {
      withdrawable: d.totalMainProviderBalance,
      cashWallet: d.balance,
      userName: d.userName ?? null,
      vip: d.vipInfo
        ? {
            nowVipName: d.vipInfo.nowVipName,
            nowVipPercent: d.vipInfo.nowVipPercent,
            nextVipName: d.vipInfo.nextVipName,
          }
        : null,
      providerStatuses: d.providerExtraData ?? [],
    };
  } else if (mainSiteResult.status === "rejected") {
    const m = errMessage(mainSiteResult.reason);
    logger.warn("9WOverview", `withdrawable (mainSite) failed: ${m}`);
    errors.mainSite = m;
  }

  // --- turnover (empty = can withdraw) ---
  let turnover: {
    canWithdraw: boolean;
    recordsCount: number;
    records: unknown[];
  } | null = null;
  if (turnoverResult.status === "fulfilled" && turnoverResult.value) {
    const t = turnoverResult.value;
    const tStatus = t.status;
    const tMessage = t.message;
    if (isMainSiteOk(t)) {
      turnover = {
        canWithdraw: t.data.records.length === 0,
        recordsCount: t.data.pageInfo.totalRecords,
        records: t.data.records,
      };
    } else {
      errors.turnover = `status ${tStatus}: ${tMessage}`;
    }
  } else if (turnoverResult.status === "rejected") {
    const m = errMessage(turnoverResult.reason);
    logger.warn("9WOverview", `turnover failed: ${m}`);
    errors.turnover = m;
  }

  // --- live unmatched tickets from provider (ticket id source of truth) ---
  let unmatchedTickets: unknown[] = [];
  if (unmatchedResult.status === "fulfilled") {
    unmatchedTickets = unmatchedResult.value.geniusSportsUnMatchTickets ?? [];
  } else {
    errors.unmatched = errMessage(unmatchedResult.reason);
  }

  // --- reconciliation run (side-effect: attaches ticket ids to pending rows) ---
  let reconciled: ReconcileReport | null = null;
  if (reconciledResult.status === "fulfilled") {
    reconciled = reconciledResult.value;
  } else {
    errors.reconcile = errMessage(reconciledResult.reason);
  }

  return NextResponse.json({
    ok: Object.keys(errors).length === 0,
    at,
    providerInfo,
    mainSite,
    turnover,
    unmatchedTickets,
    autoLogin: getAutoLoginConfig(),
    reconciled,
    errors,
  });
}

// --------------------------------------------------------------------
// Main-site fetch helpers
//
// These call 9wktsbest.com/api/bt/... with the JWT captured during
// Playwright login (stored in sessions/9wkts/session.json as
// `accessToken`). Cloudflare is lenient to these from our server when
// we include X-Internal-Request + the standard browser headers.
//
// If the JWT has expired and auto-login is ON, getSession() launches
// Playwright and re-captures both the jsessionid AND the JWT. If
// auto-login is OFF, we surface AutoLoginDisabledError.
// --------------------------------------------------------------------

// Requests go through `mainSiteFetchJson` — a persistent Chromium
// context via Playwright that bypasses Cloudflare's challenge. Raw
// Node fetch returns 403 with a 200KB interstitial HTML page.

/**
 * Re-run a main-site fetch with a fresh JWT when the first attempt
 * surfaces `MainSiteAuthExpiredError`. The session on disk is dropped
 * and `getSession(true)` forces a Playwright re-login. We only retry
 * once: a second auth failure means the re-login itself didn't produce
 * a usable token (credentials changed, CF hard-block, etc.), and the
 * caller gets a clear error instead of a silent loop.
 */
async function callMainSiteWithJwtRetry<T>(
  fn: (jwt: string) => Promise<T>,
): Promise<T | null> {
  const session = await getSession();
  if (!session.accessToken) return null;
  try {
    return await fn(session.accessToken);
  } catch (err) {
    if (!(err instanceof MainSiteAuthExpiredError)) throw err;
    logger.warn(
      "9WOverview",
      `main-site JWT rejected, forcing session refresh: ${err.message}`,
    );
    invalidateSession();
    const fresh = await getSession(true);
    if (!fresh.accessToken) return null;
    return fn(fresh.accessToken);
  }
}

async function fetchMainSitePlayerInfo(): Promise<MainSitePlayerInfo | null> {
  return callMainSiteWithJwtRetry(async (jwt) => {
    const env = await mainSiteFetchJson<MainSitePlayerInfoResponse>({
      method: "GET",
      path: "/api/bt/v1/user/getPlayerInfo?isLogin=true&currencyTypeId=8&languageTypeId=1",
      jwt,
      referer: "https://9wktsbest.com/bd/en/EXSport",
    });
    const envStatus = env.status;
    const envMessage = env.message;
    if (!isMainSiteOk(env)) {
      throw new Error(
        `getPlayerInfo error envelope: ${envStatus} ${envMessage}`,
      );
    }
    return env.data;
  });
}

async function fetchTurnover(): Promise<TurnoverListResponse | null> {
  return callMainSiteWithJwtRetry(async (jwt) => {
    return mainSiteFetchJson<TurnoverListResponse>({
      method: "GET",
      path: "/api/bt/v1/bonus/getTurnoverList?isLogin=true&currencyTypeId=8&languageTypeId=1&bonusTurnoverStats=1&pageSize=20&currentPage=1",
      jwt,
      referer: "https://9wktsbest.com/bd/en/member/turnover/uncomplete",
    });
  });
}

function errMessage(reason: unknown): string {
  if (reason instanceof AutoLoginDisabledError) return reason.message;
  if (reason instanceof Error) return reason.message;
  return String(reason);
}
