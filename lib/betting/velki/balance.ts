/**
 * Velki balance read with auto-recapture-on-zero policy.
 *
 * The provider tier sometimes returns `betCredit: 0` even when the
 * account has funds — this is a signature of a stale-but-not-yet-401'd
 * JSESSIONID (the upstream platform serves a "drift" zero instead of a
 * clean 401 when the session has been kicked but our token hasn't
 * actively been used to trip the auth check yet).
 *
 * Policy:
 *   1. Call `queryPlayerInfo()` once. If `betCredit > 0`, return.
 *   2. If `betCredit === 0`:
 *      • If auto-login is OFF → trust the value (operator may genuinely
 *        have an empty wallet, OR they're working on Velki manually
 *        and we MUST NOT race them with a recapture).
 *      • If auto-login is ON → invalidate the session, force a fresh
 *        JSESSIONID, and re-query. The second value is authoritative.
 *
 * This intentionally avoids the 9W-style main-site fallback: Velki's
 * main wallet endpoint is no longer fetched (per 2026-04-26 product
 * decision — the dual source created its own drift, and the
 * provider-tier value is the only one that matters for placement
 * anyway).
 */
import { queryPlayerInfo } from "./client";
import {
  getSession,
  invalidateSession,
  VelkiSessionExpiredError,
} from "./session";
import {
  isVelkiAutoLoginEnabled,
  VelkiAutoLoginDisabledError,
} from "./auto-login-config";
import type { VelkiPlayerInfoResponse } from "./types";

export interface VelkiBalanceReadResult {
  info: VelkiPlayerInfoResponse;
  /** True when we re-captured because of a drift-zero. Useful for telemetry. */
  recaptured: boolean;
}

export async function readPlayerInfoWithRecapture(): Promise<VelkiBalanceReadResult> {
  const first = await queryPlayerInfo();
  if (first.betCredit > 0) {
    return { info: first, recaptured: false };
  }

  // Drift-zero. Only force a recapture when the operator hasn't paused
  // auto-login — otherwise we'd kick their manual session.
  if (!isVelkiAutoLoginEnabled()) {
    return { info: first, recaptured: false };
  }

  invalidateSession();
  try {
    await getSession(true);
  } catch (err) {
    // AutoLoginDisabledError is a race (operator just paused while we
    // were mid-call) — return the original zero rather than fighting.
    if (err instanceof VelkiAutoLoginDisabledError) {
      return { info: first, recaptured: false };
    }
    if (err instanceof VelkiSessionExpiredError) {
      throw err;
    }
    throw err;
  }

  const second = await queryPlayerInfo();
  return { info: second, recaptured: true };
}
