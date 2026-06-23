import { NextResponse } from "next/server";
import {
  getVelkiAutoLoginConfig,
  setVelkiAutoLoginConfig,
} from "@/lib/betting/velki/auto-login-config";
import { invalidateSession } from "@/lib/betting/velki/session";
import { resetCircuitBreaker } from "@/lib/shared/circuit-breaker";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return NextResponse.json(getVelkiAutoLoginConfig());
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

  const prev = getVelkiAutoLoginConfig();
  const updated = setVelkiAutoLoginConfig(body.enabled, reason);

  if (!prev.enabled && body.enabled) {
    invalidateSession();
    resetCircuitBreaker("velki-sportsbook");
  }

  return NextResponse.json(updated);
}
