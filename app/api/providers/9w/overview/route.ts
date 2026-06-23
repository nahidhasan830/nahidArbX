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

  const [providerInfoResult, unmatchedResult, reconciledResult] =
    await Promise.allSettled([
      queryPlayerInfo(),
      fetchUnMatchedTickets(),
      reconcilePendingBets(),
    ]);

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

  let unmatchedTickets: unknown[] = [];
  if (unmatchedResult.status === "fulfilled") {
    unmatchedTickets = unmatchedResult.value.geniusSportsUnMatchTickets ?? [];
  } else {
    errors.unmatched = errMessage(unmatchedResult.reason);
  }

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
