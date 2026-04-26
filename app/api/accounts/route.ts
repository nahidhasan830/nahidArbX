/**
 * GET /api/betting-accounts
 *
 * Returns live balance/exposure/status + session health for every
 * configured betting account. 9W Sportsbook is the real account;
 * 9W Exchange is currently returned as demo data.
 *
 * POST /api/betting-accounts
 *   body: { provider: string, action: "relogin" }
 *
 * Forces a fresh Playwright login for the given provider. Used by the
 * dashboard's "Re-login" button when the operator wants to recover
 * from a dead session without waiting for the next API call to
 * trigger it.
 */
import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { queryPlayerInfo } from "@/lib/betting/ninewickets/client";
import {
  getSession,
  invalidateSession,
  shutdownSessionBrowser,
} from "@/lib/betting/ninewickets/session";
import { queryPlayerInfo as queryVelkiPlayerInfo } from "@/lib/betting/velki/client";
import {
  getSession as getVelkiSession,
  invalidateSession as invalidateVelkiSession,
} from "@/lib/betting/velki/session";
import { readPlayerInfoWithRecapture } from "@/lib/betting/velki/balance";
import { resetCircuitBreaker } from "@/lib/shared/circuit-breaker";
import { DEMO_ACCOUNT } from "@/lib/betting/dummy-data";
import { isAutoPlaceEnabled } from "@/lib/betting/auto-place-config";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export type SessionHealth = "healthy" | "expiring" | "expired" | "unknown";

export interface BettingAccount {
  provider: string;
  providerDisplayName: string;
  username: string | null;
  currency: string;
  balance: number | null;
  exposure: number | null;
  minBet: number | null;
  suspended: boolean;
  lastSyncedAt: string;
  error: string | null;
  isDemo: boolean;
  autoPlaceEnabled: boolean;
  session: {
    health: SessionHealth;
    capturedAt: string | null;
    expiresAt: string | null;
    msUntilExpiry: number | null;
  };
}

const SESSION_FILE_9W = path.join("sessions", "9wkts", "session.json");
const SESSION_FILE_VELKI = path.join("sessions", "velki", "session.json");
const EXPIRING_WINDOW_MS = 10 * 60 * 1000;

export async function GET() {
  // Fetch in parallel — 9W's Playwright relogin can take 3-5s, no
  // reason to block Velki on it.
  const [nineW, velki] = await Promise.all([
    fetch9wktsAccount(),
    fetchVelkiAccount(),
  ]);
  const accounts: BettingAccount[] = [nineW, velki, buildDemoAccount()];
  return NextResponse.json({ accounts });
}

export async function POST(req: Request) {
  let body: { provider?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const provider = body.provider;
  const action = body.action;
  if (!provider || !action) {
    return NextResponse.json(
      { error: "provider + action required" },
      { status: 400 },
    );
  }

  if (action !== "relogin") {
    return NextResponse.json(
      { error: `Unknown action: ${action}` },
      { status: 400 },
    );
  }

  try {
    if (provider === "ninewickets-sportsbook") {
      // Full clean-slate: invalidate the stale session, dispose the
      // warm Chromium (otherwise a tainted browser instance keeps
      // failing every capture), and reset both 9W circuit breakers
      // so the first post-recovery request actually hits the book.
      // Mirrors the off→on auto-login toggle path — same problem,
      // same cure.
      invalidateSession();
      await shutdownSessionBrowser();
      resetCircuitBreaker("ninewickets-exchange");
      resetCircuitBreaker("ninewickets-sportsbook");
      const fresh = await getSession(true);
      const info = await queryPlayerInfo();
      return NextResponse.json({
        ok: true,
        session: buildSessionStatus(fresh.accessTokenExp, fresh.capturedAt),
        balance: info.betCredit,
      });
    }

    if (provider === "velki-sportsbook") {
      // Velki has no Playwright / Cloudflare layer — the 3-step REST
      // chain in captureSession handles re-auth on its own. Just wipe
      // the session and call queryPlayerInfo (which goes through the
      // capture-with-retries wrapper).
      invalidateVelkiSession();
      resetCircuitBreaker("velki-sportsbook");
      const fresh = await getVelkiSession(true);
      const info = await queryVelkiPlayerInfo();
      return NextResponse.json({
        ok: true,
        session: buildVelkiSessionStatus(fresh.capturedAt),
        balance: info.betCredit,
      });
    }

    return NextResponse.json(
      { error: `Re-login not supported for ${provider}` },
      { status: 400 },
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

async function fetch9wktsAccount(): Promise<BettingAccount> {
  const stored = read9wSessionMeta();
  const base: BettingAccount = {
    provider: "ninewickets-sportsbook",
    providerDisplayName: "9W Sportsbook",
    username: process.env.NINEWICKETS_USERNAME ?? null,
    currency: "BDT",
    balance: null,
    exposure: null,
    minBet: null,
    suspended: false,
    lastSyncedAt: new Date().toISOString(),
    error: null,
    isDemo: false,
    autoPlaceEnabled: isAutoPlaceEnabled("ninewickets-sportsbook"),
    session: buildSessionStatus(stored.exp, stored.capturedAt),
  };

  try {
    const info = await queryPlayerInfo();
    // queryPlayerInfo may have rotated the session (auto re-login) —
    // re-read disk so the UI shows the fresh expiry.
    const latest = read9wSessionMeta();
    return {
      ...base,
      balance: info.betCredit,
      exposure: info.totalExposure,
      minBet: info.minBet,
      suspended:
        Boolean(info.accountSuspended) ||
        Boolean(info.accountSysSuspended) ||
        Boolean(info.accountVoidSuspended),
      lastSyncedAt: new Date().toISOString(),
      session: buildSessionStatus(latest.exp, latest.capturedAt),
    };
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchVelkiAccount(): Promise<BettingAccount> {
  const stored = readVelkiSessionMeta();
  const base: BettingAccount = {
    provider: "velki-sportsbook",
    providerDisplayName: "Velki Sportsbook",
    username: process.env.VELKI_USERNAME ?? null,
    currency: "BDT",
    balance: null,
    exposure: null,
    minBet: null,
    suspended: false,
    lastSyncedAt: new Date().toISOString(),
    error: null,
    isDemo: false,
    autoPlaceEnabled: isAutoPlaceEnabled("velki-sportsbook"),
    session: buildVelkiSessionStatus(stored.capturedAt),
  };

  try {
    // Provider-tier balance is the only source of truth (main-site
    // wallet was retired 2026-04-26 to eliminate dual-source drift).
    // Drift-zero detection: when betCredit reads 0 and auto-login is
    // ON, the helper invalidates the JSESSIONID and re-queries — a
    // zero from a stale session is the most common cause of the "BDT
    // 0.00" UI bug. Operator-paused auto-login skips the recapture so
    // a manual login on Velki isn't kicked.
    const { info } = await readPlayerInfoWithRecapture();
    const latest = readVelkiSessionMeta();
    return {
      ...base,
      balance: info.betCredit,
      exposure: info.totalExposure,
      minBet: info.minBet,
      suspended:
        Boolean(info.accountSuspended) || Boolean(info.accountSysSuspended),
      lastSyncedAt: new Date().toISOString(),
      session: buildVelkiSessionStatus(latest.capturedAt),
    };
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildDemoAccount(): BettingAccount {
  return {
    provider: DEMO_ACCOUNT.provider,
    providerDisplayName: DEMO_ACCOUNT.providerDisplayName,
    username: DEMO_ACCOUNT.username,
    currency: DEMO_ACCOUNT.currency,
    balance: DEMO_ACCOUNT.balance,
    exposure: DEMO_ACCOUNT.exposure,
    minBet: DEMO_ACCOUNT.minBet,
    suspended: DEMO_ACCOUNT.suspended,
    lastSyncedAt: new Date().toISOString(),
    error: null,
    isDemo: true,
    autoPlaceEnabled: false,
    session: {
      health: "unknown",
      capturedAt: null,
      expiresAt: null,
      msUntilExpiry: null,
    },
  };
}

function read9wSessionMeta(): {
  exp: number | null;
  capturedAt: string | null;
} {
  try {
    if (!fs.existsSync(SESSION_FILE_9W)) {
      return { exp: null, capturedAt: null };
    }
    const raw = fs.readFileSync(SESSION_FILE_9W, "utf8");
    const parsed = JSON.parse(raw) as {
      accessTokenExp?: number;
      capturedAt?: string;
    };
    return {
      exp: parsed.accessTokenExp ?? null,
      capturedAt: parsed.capturedAt ?? null,
    };
  } catch {
    return { exp: null, capturedAt: null };
  }
}

function readVelkiSessionMeta(): { capturedAt: string | null } {
  try {
    if (!fs.existsSync(SESSION_FILE_VELKI)) return { capturedAt: null };
    const raw = fs.readFileSync(SESSION_FILE_VELKI, "utf8");
    const parsed = JSON.parse(raw) as { capturedAt?: string };
    return { capturedAt: parsed.capturedAt ?? null };
  } catch {
    return { capturedAt: null };
  }
}

/**
 * Velki tokens are opaque — no exp claim. Until a request actually 401s
 * we can't tell if a stored session is still good. Mark health as
 * "healthy" if we have any captured session, "unknown" otherwise. The
 * dashboard's auto-refresh will surface real failures via `error`.
 */
function buildVelkiSessionStatus(
  capturedAt: string | null,
): BettingAccount["session"] {
  return {
    health: capturedAt ? "healthy" : "unknown",
    capturedAt,
    expiresAt: null,
    msUntilExpiry: null,
  };
}

function buildSessionStatus(
  accessTokenExp: number | null,
  capturedAt: string | null,
): BettingAccount["session"] {
  if (!accessTokenExp) {
    return {
      health: "unknown",
      capturedAt,
      expiresAt: null,
      msUntilExpiry: null,
    };
  }
  const expMs = accessTokenExp * 1000;
  const msUntil = expMs - Date.now();
  const expiresAt = new Date(expMs).toISOString();

  let health: SessionHealth;
  if (msUntil <= 0) health = "expired";
  else if (msUntil <= EXPIRING_WINDOW_MS) health = "expiring";
  else health = "healthy";

  return {
    health,
    capturedAt,
    expiresAt,
    msUntilExpiry: msUntil,
  };
}
