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
  getAutoLoginConfig,
  AutoLoginDisabledError,
} from "@/lib/betting/ninewickets/auto-login-config";
import {
  fetchUnMatchedTickets,
  reconcilePendingBets,
  type ReconcileReport,
} from "@/lib/betting/ninewickets/reconciler";


export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const at = new Date().toISOString();
  const errors: Record<string, string> = {};

  // Run in parallel — each slice is independently resilient.
  const [providerInfoResult, unmatchedResult, reconciledResult] =
    await Promise.allSettled([
      queryPlayerInfo(),
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
    unmatchedTickets,
    autoLogin: getAutoLoginConfig(),
    reconciled,
    errors,
  });
}

function errMessage(reason: unknown): string {
  if (reason instanceof AutoLoginDisabledError) return reason.message;
  if (reason instanceof Error) return reason.message;
  return String(reason);
}
