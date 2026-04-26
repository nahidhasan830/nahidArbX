/**
 * Velki provider-tier client. Talks to saapipl.fwick7ets.xyz using the
 * JSESSIONID captured by the session manager.
 *
 * This is the symmetric counterpart to NineWickets' client.ts — same
 * `;jsessionid=…` URL pattern, same raw-JSESSIONID-as-Authorization
 * header. The two providers are evidently sister deployments of the
 * same upstream platform.
 */
import { callWithSessionRetry, VelkiSessionExpiredError } from "./session";
import { validateAndParse } from "../../shared/validation";
import {
  VelkiPlayerInfoResponseSchema,
  VelkiTurnoverListResponseSchema,
  VelkiWalletResponseSchema,
} from "../../shared/schemas/velki";
import type {
  VelkiPlayerInfoResponse,
  VelkiTurnoverListResponse,
  VelkiWalletResponse,
} from "./types";
import { toBDT, toBDTFromString } from "./units";

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

// =====================================================================
// queryPlayerInfo — bettable wallet
// =====================================================================

export async function queryPlayerInfo(): Promise<VelkiPlayerInfoResponse> {
  return callWithSessionRetry(async (session) => {
    const url = `${PROVIDER_API_HOST}/member/playerService/queryPlayerInfo;jsessionid=${session.jsessionid}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: session.jsessionid,
        // The provider tier sets a JSESSIONID cookie on the bridge
        // hop; replay it on every call alongside the URL-path
        // jsessionid for belt-and-braces.
        Cookie: `JSESSIONID=${session.jsessionid}`,
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw new VelkiSessionExpiredError(`queryPlayerInfo ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(`[Velki] queryPlayerInfo HTTP ${res.status}`);
    }
    const text = await res.text();
    const trimmed = text.trim();
    if (trimmed.startsWith("<")) {
      // HTML body == upstream login page == session is dead.
      throw new VelkiSessionExpiredError("queryPlayerInfo returned HTML");
    }
    if (trimmed.length === 0) {
      // WAF silently rejecting (missing Origin/Referer signature).
      throw new VelkiSessionExpiredError("queryPlayerInfo returned empty body");
    }
    const body = JSON.parse(trimmed) as unknown;
    // Error-envelope sniff. Two known signals for "session is dead":
    //   - status "1001" / desc "Not Authorized."
    //   - status "9999" / status_msg "You have been logged off ..."
    //     (single-session enforcement: another tab/IP grabbed it)
    // Both should trigger a fresh capture.
    const statusVal = (body as { status?: unknown }).status;
    if (
      (typeof statusVal === "string" && statusVal !== "0") ||
      typeof statusVal === "number"
    ) {
      const env = body as {
        status: string | number;
        desc?: string;
        message?: string;
        status_msg?: string;
      };
      const code = String(env.status);
      const text = (
        env.desc ??
        env.message ??
        env.status_msg ??
        ""
      ).toLowerCase();
      const unauthorized =
        code === "1001" ||
        code === "9999" ||
        text.includes("not authorized") ||
        text.includes("logged off");
      if (unauthorized) {
        throw new VelkiSessionExpiredError(
          `queryPlayerInfo session lost (${code} ${text})`,
        );
      }
      throw new Error(
        `[Velki] queryPlayerInfo error envelope: ${code} ${text}`,
      );
    }
    const parsed = validateAndParse(
      body,
      VelkiPlayerInfoResponseSchema,
      "[Velki] queryPlayerInfo",
    );
    if (!parsed) {
      throw new Error("[Velki] queryPlayerInfo failed schema validation");
    }
    // Velki returns currency in 0.01-BDT units. Normalize at boundary so
    // every consumer sees plain BDT — see ./units.ts.
    return {
      ...parsed,
      betCredit: toBDT(parsed.betCredit),
      totalExposure: toBDT(parsed.totalExposure),
      creditAllocated: toBDT(parsed.creditAllocated),
      minBet: toBDT(parsed.minBet),
    } as VelkiPlayerInfoResponse;
  });
}

// =====================================================================
// MAIN-tier reads (vk-sa.softtake.net, DRF token auth)
//
// These hit Velki's MAIN host with `Authorization: Token <token>`. They
// use the same `callWithSessionRetry` wrapper so a stale token gets
// recaptured automatically — getSession() returns the most recent
// `session.token` value on each call.
// =====================================================================

const MAIN_HOST = "https://vk-sa.softtake.net";
const VELKI_ORIGIN = "https://velki.live";

const MAIN_BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: VELKI_ORIGIN,
  Referer: `${VELKI_ORIGIN}/`,
};

/**
 * GET /account/wallet — withdrawable balance + exposure_limit (numbers).
 *
 * NOTE: numbers here. The /account/profile endpoint returns the same
 * fields as STRINGS — prefer this one for live UI display.
 */
export async function fetchMainWallet(): Promise<VelkiWalletResponse> {
  return callWithSessionRetry(async (session) => {
    const res = await fetch(`${MAIN_HOST}/account/wallet`, {
      method: "GET",
      headers: {
        ...MAIN_BROWSER_HEADERS,
        Authorization: `Token ${session.token}`,
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw new VelkiSessionExpiredError(`/account/wallet ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(`[Velki] /account/wallet HTTP ${res.status}`);
    }
    const body = (await res.json()) as unknown;
    const parsed = validateAndParse(
      body,
      VelkiWalletResponseSchema,
      "[Velki] /account/wallet",
    );
    if (!parsed) {
      throw new Error("[Velki] /account/wallet failed schema validation");
    }
    if (!parsed.success || parsed.errcode !== "0") {
      throw new Error(
        `[Velki] /account/wallet refused: ${parsed.message} (errcode=${parsed.errcode})`,
      );
    }
    // Scale all wallet numbers from Velki-units to BDT. See ./units.ts.
    const w = parsed.data.wallet;
    return {
      ...parsed,
      data: {
        ...parsed.data,
        wallet: {
          credit_balance: toBDT(w.credit_balance),
          available_credit_balance: toBDT(w.available_credit_balance),
          coin_balance: toBDT(w.coin_balance),
          exposure_limit: toBDT(w.exposure_limit),
        },
      },
    } as VelkiWalletResponse;
  });
}

/**
 * GET /turnover/list — list of bonus/deposit wagering-requirement
 * records. SIC: the response key is `tunovers` (missing the 'r').
 */
export async function fetchMainTurnover(): Promise<VelkiTurnoverListResponse> {
  return callWithSessionRetry(async (session) => {
    const res = await fetch(`${MAIN_HOST}/turnover/list`, {
      method: "GET",
      headers: {
        ...MAIN_BROWSER_HEADERS,
        Authorization: `Token ${session.token}`,
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw new VelkiSessionExpiredError(`/turnover/list ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(`[Velki] /turnover/list HTTP ${res.status}`);
    }
    const body = (await res.json()) as unknown;
    const parsed = validateAndParse(
      body,
      VelkiTurnoverListResponseSchema,
      "[Velki] /turnover/list",
    );
    if (!parsed) {
      throw new Error("[Velki] /turnover/list failed schema validation");
    }
    if (!parsed.success || parsed.errcode !== "0") {
      throw new Error(
        `[Velki] /turnover/list refused: ${parsed.message} (errcode=${parsed.errcode})`,
      );
    }
    // Turnover amounts arrive as strings ("20.0000"). Parse, scale to
    // BDT, and re-stringify so the wire shape (string) is preserved
    // and the existing `toNum` helper on the frontend keeps working.
    // `turnover_achieved` is a percentage — left untouched.
    const scaled = parsed.data.tunovers.map((r) => ({
      ...r,
      base_amount: scaleAmountString(r.base_amount),
      required_turnover_amount: scaleAmountString(r.required_turnover_amount),
      complete_turnover_amount: scaleAmountString(r.complete_turnover_amount),
    }));
    return {
      ...parsed,
      data: { ...parsed.data, tunovers: scaled },
    } as VelkiTurnoverListResponse;
  });
}

function scaleAmountString(value: string): string {
  const bdt = toBDTFromString(value);
  if (Number.isNaN(bdt)) return value; // pass garbage through unchanged
  return bdt.toFixed(4); // preserve 4-decimal style of the wire format
}
