/**
 * Velki overview — one-shot bundle for the dashboard.
 *
 * Mirrors /api/providers/9w/overview but for Velki Sportsbook. Keeps
 * the response shape close so BettingAccountsPanel can consume either
 * with shared rendering code, but Velki intentionally does NOT fetch
 * the main-site wallet or turnover any more (2026-04-26 product
 * decision):
 *
 *   • The dual source — provider-tier `betCredit` vs. main-tier
 *     `available_credit_balance` — created its own drift (one would
 *     read 0 while the other read true balance during JSESSIONID
 *     handovers). The provider tier is the only value that matters for
 *     placement, so that's the only one we read.
 *
 *   • When the provider tier returns `betCredit: 0` while auto-login is
 *     ON, the helper invalidates the JSESSIONID and re-captures — that
 *     pattern is a stale-session drift signal, not an empty wallet. If
 *     auto-login is OFF (operator working manually), we trust the zero
 *     and leave the session alone.
 *
 *   • `mainSite` is kept in the response shape (always null) so the
 *     dashboard normalizer doesn't have to branch — the UI hides the
 *     "Withdrawable" tile when null, which is the correct visual.
 *
 *   • `turnover` is also retired (was sourced from the main-site only).
 *
 *   • Conservative on partial failure: any single dependency failing
 *     surfaces under `errors[name]` rather than 500'ing the response.
 */
import { NextResponse } from "next/server";
import { readPlayerInfoWithRecapture } from "@/lib/betting/velki/balance";
import { getVelkiAutoLoginConfig } from "@/lib/betting/velki/auto-login-config";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const at = new Date().toISOString();
  const errors: Record<string, string> = {};

  let providerInfo: {
    betCredit: number;
    exposure: number;
    suspended: boolean;
    minBet: number;
  } | null = null;
  let recaptured = false;

  try {
    const result = await readPlayerInfoWithRecapture();
    const info = result.info;
    recaptured = result.recaptured;
    providerInfo = {
      betCredit: info.betCredit,
      exposure: info.totalExposure,
      suspended:
        Boolean(info.accountSuspended) || Boolean(info.accountSysSuspended),
      minBet: info.minBet,
    };
  } catch (err) {
    errors.providerInfo = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json({
    ok: Object.keys(errors).length === 0,
    at,
    providerInfo,
    mainSite: null,
    turnover: null,
    autoLogin: getVelkiAutoLoginConfig(),
    recaptured,
    errors,
  });
}
