/**
 * Velki auto-login kill switch API.
 *
 *   GET  → current { enabled, reason, updatedAt }
 *   POST { enabled: boolean, reason?: string }
 *        → flips the flag, persists to sessions/velki/auto-login.json
 *
 * Symmetric to /api/providers/9w/auto-login. Off → on transition wipes
 * the cached session + resets the Velki circuit breaker so the next
 * dashboard tick does a completely fresh capture instead of riding a
 * stale session that's already been kicked.
 */
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
