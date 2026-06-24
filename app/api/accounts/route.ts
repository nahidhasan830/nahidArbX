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
  autoPlaceEnabled: boolean;
  session: {
    health: SessionHealth;
    capturedAt: string | null;
  };
}

const SESSION_FILE_9W = path.join("sessions", "9wkts", "session.json");
const SESSION_FILE_VELKI = path.join("sessions", "velki", "session.json");
const EXPIRING_WINDOW_MS = 10 * 60 * 1000;

export async function GET() {
  const [nineW, velki] = await Promise.all([
    fetch9wktsAccount(),
    fetchVelkiAccount(),
  ]);
  const accounts: BettingAccount[] = [nineW, velki];
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
    autoPlaceEnabled: isAutoPlaceEnabled("ninewickets-sportsbook"),
    session: buildSessionStatus(stored.exp, stored.capturedAt),
  };

  try {
    const info = await queryPlayerInfo();
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
    autoPlaceEnabled: isAutoPlaceEnabled("velki-sportsbook"),
    session: buildVelkiSessionStatus(stored.capturedAt),
  };

  try {
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

function buildVelkiSessionStatus(
  capturedAt: string | null,
): BettingAccount["session"] {
  return {
    health: capturedAt ? "healthy" : "unknown",
    capturedAt,
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
    };
  }
  const expMs = accessTokenExp * 1000;
  const msUntil = expMs - Date.now();

  let health: SessionHealth;
  if (msUntil <= 0) health = "expired";
  else if (msUntil <= EXPIRING_WINDOW_MS) health = "expiring";
  else health = "healthy";

  return {
    health,
    capturedAt,
  };
}
