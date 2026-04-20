/**
 * POST /api/bets/market-limits
 *
 * Pre-placement lookup. The placement modal calls this on open to learn
 * the book-imposed min/max stake for a specific (event, atom) and the
 * account's current balance, so it can:
 *   1. Prefill the stake field intelligently (Kelly when valid; else min)
 *   2. Disable the Place button when the current stake is invalid
 *   3. Surface the limits inline instead of surprising the operator with
 *      a server-side rejection after they click Place.
 *
 * The per-market min/max is captured by the odds-ingest path
 * (`lib/atoms/adapters/ninewickets-sportsbook.ts`) on every sync cycle
 * and stashed in `lib/atoms/market-limits-store.ts`. This endpoint just
 * reads it — no extra HTTP call to the book.
 *
 * Body:
 *   {
 *     softProvider: string,
 *     eventId: string,
 *     atomId: string
 *   }
 *
 * Response:
 *   {
 *     minBet: number,
 *     maxBet: number | null,   // null when book doesn't expose a cap
 *     balance: number,
 *     currency: string,
 *     accountMinBet: number,   // fallback used if per-market limits missing
 *     source: "market" | "account",
 *     suspended: boolean,
 *     limitsAgeMs: number | null
 *   }
 */
import { NextResponse } from "next/server";
import { getBettingProvider } from "@/lib/betting/registry";
import {
  clearMarketLimits,
  getMarketLimits,
  marketLimitsStoreSize,
} from "@/lib/atoms/market-limits-store";
import { logger } from "@/lib/shared/logger";
import type { ProviderKey } from "@/lib/atoms/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface Body {
  softProvider?: string;
  eventId?: string;
  atomId?: string;
}

/** GET for quick diagnostics — returns store size + optional lookup. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("clear") === "1") {
    clearMarketLimits();
    return NextResponse.json({ cleared: true, storeSize: 0 });
  }
  const softProvider = url.searchParams.get("softProvider");
  const eventId = url.searchParams.get("eventId");
  const atomId = url.searchParams.get("atomId");
  if (softProvider && eventId && atomId) {
    const cached = getMarketLimits(
      softProvider as ProviderKey,
      eventId,
      atomId,
    );
    return NextResponse.json({
      storeSize: marketLimitsStoreSize(),
      cached,
    });
  }
  return NextResponse.json({ storeSize: marketLimitsStoreSize() });
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { softProvider, eventId, atomId } = body;

  if (!softProvider || !eventId || !atomId) {
    return NextResponse.json(
      { error: "softProvider, eventId, atomId are required" },
      { status: 400 },
    );
  }

  const adapter = getBettingProvider(softProvider);
  if (!adapter) {
    return NextResponse.json(
      { error: `No betting adapter configured for "${softProvider}"` },
      { status: 404 },
    );
  }

  let account;
  try {
    account = await adapter.getAccountInfo();
  } catch (err) {
    logger.error("MarketLimitsAPI", "getAccountInfo failed", {
      softProvider,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Account info fetch failed" },
      { status: 502 },
    );
  }

  // Read the per-market limits captured during the last odds sync. If
  // the atom wasn't seen this cycle (e.g. market suspended, or we
  // haven't synced the event yet) the store returns null and we fall
  // back to the account-level minBet.
  const cached = getMarketLimits(softProvider as ProviderKey, eventId, atomId);

  const source: "market" | "account" = cached ? "market" : "account";
  const minBet = cached ? cached.minBet : account.minBet;
  const maxBet = cached ? cached.maxBet : null;
  const limitsAgeMs = cached ? Date.now() - cached.timestamp : null;

  if (!cached) {
    logger.warn(
      "MarketLimitsAPI",
      "no cached limits — falling back to account",
      {
        softProvider,
        eventId,
        atomId,
        storeSize: marketLimitsStoreSize(),
      },
    );
  }

  return NextResponse.json({
    minBet,
    maxBet,
    balance: account.balance,
    currency: account.currency,
    accountMinBet: account.minBet,
    source,
    suspended: account.suspended,
    limitsAgeMs,
  });
}
