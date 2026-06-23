import { NextResponse } from "next/server";
import {
  getAutoLoginConfig,
  setAutoLoginConfig,
} from "@/lib/betting/ninewickets/auto-login-config";
import {
  invalidateSession,
  shutdownSessionBrowser,
} from "@/lib/betting/ninewickets/session";
import { resetCircuitBreaker } from "@/lib/shared/circuit-breaker";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return NextResponse.json(getAutoLoginConfig());
}

export async function POST(req: Request) {
  let body: { enabled?: unknown; reason?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "`enabled` (boolean) required" },
      { status: 400 },
    );
  }

  const reason =
    typeof body.reason === "string" && body.reason.trim().length > 0
      ? body.reason.trim().slice(0, 200)
      : null;

  const prev = getAutoLoginConfig();
  const updated = setAutoLoginConfig(body.enabled, reason);

  if (!prev.enabled && body.enabled) {
    invalidateSession();
    await shutdownSessionBrowser();
    resetCircuitBreaker("ninewickets-exchange");
    resetCircuitBreaker("ninewickets-sportsbook");
  }

  return NextResponse.json(updated);
}
