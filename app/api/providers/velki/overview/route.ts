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
