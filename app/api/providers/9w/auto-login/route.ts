/**
 * 9W auto-login kill switch API.
 *
 *   GET  → current { enabled, reason, updatedAt }
 *   POST { enabled: boolean, reason?: string }
 *        → flips the flag, persists to sessions/9wkts/auto-login.json
 *
 * Purpose: 9W enforces one-active-session-per-account. When the
 * operator is working manually on 9wktsbest.com, they flip auto-login
 * OFF so our background `getSession()` doesn't launch a Playwright
 * login that would kick them off. See
 * `lib/betting/ninewickets/auto-login-config.ts` for full rationale.
 */
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

  // Off → on transition is almost always "the operator just finished
  // a manual session on their phone / another device, flip back on".
  // Under 9W's single-session rule the server-side tokens are already
  // stale, and the warm Chromium we had running through the pause may
  // have ended up in a bad state. Wipe both so the next background
  // tick does a completely fresh login instead of burning another
  // 30-second timeout discovering the tokens are invalid.
  if (!prev.enabled && body.enabled) {
    invalidateSession();
    await shutdownSessionBrowser();
    // Circuit breakers opened by the failing-session storm would
    // otherwise short-circuit the next few sync cycles and make the
    // dashboard feel stuck. Reset both 9W breakers so the first post-
    // toggle request actually hits the book with the fresh session.
    resetCircuitBreaker("ninewickets-exchange");
    resetCircuitBreaker("ninewickets-sportsbook");
  }

  return NextResponse.json(updated);
}
