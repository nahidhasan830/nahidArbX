/**
 * 9W pending-bet reconciler.
 *
 * When a bet is placed asynchronously (book returns SUCCESS without a
 * ticket id immediately), we persist a `bets` row at
 * `outcome='pending'` with `providerTicketId = null`. The book later
 * assigns a ticket id that shows up in
 * `gakqv/queryUnMatchTicketsAndTxns` (and eventually in
 * main-site report endpoints).
 *
 * This module reconciles DB rows to the live ticket feed by matching
 * on the (eventId, marketId, selectionId, stake, odds) composite key.
 * Once matched, we copy the ticket id onto the row so it's trackable.
 *
 * See RECONCILIATION.md for the full design rationale.
 */
import { callWithSessionRetry, SessionExpiredError } from "./client";
import {
  attachTicketId,
  deleteBet,
  listPendingBetsForProvider,
} from "@/lib/db/repositories/bets";
import { logger } from "@/lib/shared/logger";
import type {
  GeniusSportsUnMatchTicket,
  QueryUnMatchTicketsResponse,
} from "./types";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const BROWSER_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://9wktsbest.com",
  Referer: "https://9wktsbest.com/",
  "sec-ch-ua": '"Chromium";v="147", "Not.A/Brand";v="8", "Brave";v="147"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
};

const UNMATCH_FIELDS: Record<string, string> = {
  unMatchTicketVersion: "0",
  txnVersion: "0",
  sportsBookTxnVersion: "0",
  fancyBetTxnVersion: "0",
  dmFancyBetTxnVersion: "0",
  bookMakerTxnVersion: "0",
  dmBookMakerTxnVersion: "0",
  sbMultiBetTxnDetailVersion: "0",
  geMultiBetTxnDetailVersion: "0",
  geMultiBetUnMatchTicketVersion: "0",
  geMultiBetUnMatchTicketDetailVersion: "0",
  sbMultiBetTxnVersion: "0",
  geMultiBetTxnVersion: "0",
  sportsBookVoucherVersion: "0",
  geniusSportsTxnVersion: "0",
};

/**
 * Fetch the live unmatched-tickets + transaction feed from the write
 * host. Throws SessionExpiredError if the session is dead — the retry
 * wrapper handles one re-login attempt.
 */
export async function fetchUnMatchedTickets(): Promise<QueryUnMatchTicketsResponse> {
  return callWithSessionRetry(async (session) => {
    const url = `https://gakqv.seofmi.live/exchange/member/playerService/queryUnMatchTicketsAndTxns;jsessionid=${session.queryPass}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: session.queryPass,
      },
      body: new URLSearchParams(UNMATCH_FIELDS).toString(),
    });
    if (res.status === 401 || res.status === 403) {
      throw new SessionExpiredError(`queryUnMatch ${res.status}`);
    }
    const text = await res.text();
    const trimmed = text.trim();
    if (trimmed.startsWith("<")) {
      throw new SessionExpiredError("queryUnMatch returned HTML");
    }
    if (trimmed.length === 0) {
      throw new SessionExpiredError("queryUnMatch returned empty body");
    }
    const parsed = JSON.parse(trimmed) as
      | QueryUnMatchTicketsResponse
      | { status?: string; message?: string };
    // Error envelope — session kicked off (single-session enforcement).
    if (typeof (parsed as { status?: unknown }).status === "string") {
      const envelope = parsed as { status: string; message?: string };
      if (envelope.status !== "0") {
        throw new SessionExpiredError(
          `queryUnMatch error envelope: ${envelope.status} ${envelope.message ?? ""}`,
        );
      }
    }
    return parsed as QueryUnMatchTicketsResponse;
  });
}

/**
 * How long a pending row is allowed to sit without a matching ticket
 * before the reconciler treats it as a silent failure and deletes it.
 *
 * Paired with a 30-second reconcile cadence (see the scheduler in
 * `lib/background/fetcher.ts`): we poll the book's myBets feed every
 * 30s so genuine confirmations show up fast, and only after five
 * minutes of continuous no-shows do we consider the placement lost
 * and purge its phantom DB row.
 */
const ORPHAN_PENDING_TTL_MS = 5 * 60 * 1000;

/** Reconciliation outcome — used for UI / logging. */
export interface ReconcileReport {
  /** Count of pending rows before reconciliation. */
  pendingBefore: number;
  /** Count of pending rows after (still-pending, ticket id was already known or still unmatched). */
  pendingAfter: number;
  /** Rows where we attached a brand-new ticket id this run. */
  ticketsAttached: number;
  /** Ticket ids observed in the provider feed for OUR pending bets. */
  observedTicketIds: string[];
  /** Pending rows that aged past {@link ORPHAN_PENDING_TTL_MS} and were deleted. */
  orphansPurged: number;
  /** When the reconciliation ran. */
  at: string;
}

interface PendingBetLike {
  id: string;
  eventId: string;
  atomId: string;
  stake: number | string;
  odds: number | string;
  providerTicketId: string | null;
  requestPayload: unknown;
  placedAt: string | Date;
}

/**
 * Extract the provider-native ids (marketId, selectionId, betfair
 * event id) from a `placed_bets.requestPayload`. The placer stored
 * whatever the adapter received. If the shape doesn't match, we
 * return a partial match key and rely on eventId + stake + odds.
 */
function extractRefs(row: PendingBetLike): {
  marketId: string | null;
  selectionId: number | null;
  betfairEventId: number | null;
} {
  try {
    const p = row.requestPayload as
      | { payloadItem?: Record<string, unknown> }
      | null
      | undefined;
    const item = p?.payloadItem ?? {};
    return {
      marketId:
        typeof item.marketId === "string" || typeof item.marketId === "number"
          ? String(item.marketId)
          : null,
      selectionId:
        typeof item.selectionId === "number"
          ? item.selectionId
          : typeof item.selectionId === "string"
            ? Number(item.selectionId)
            : null,
      betfairEventId:
        typeof item.betfairEventId === "number"
          ? item.betfairEventId
          : typeof item.betfairEventId === "string"
            ? Number(item.betfairEventId)
            : null,
    };
  } catch {
    return { marketId: null, selectionId: null, betfairEventId: null };
  }
}

/**
 * Walk all pending rows for `ninewickets-sportsbook`, fetch the live
 * unmatched feed, and attach newly-visible ticket ids to rows that
 * don't have one yet.
 *
 * Idempotent. Safe to call every N seconds.
 */
export async function reconcilePendingBets(): Promise<ReconcileReport> {
  const provider = "ninewickets-sportsbook";
  const pending = await listPendingBetsForProvider(provider);
  const pendingBefore = pending.length;
  const at = new Date().toISOString();

  if (pendingBefore === 0) {
    return {
      pendingBefore,
      pendingAfter: 0,
      ticketsAttached: 0,
      observedTicketIds: [],
      orphansPurged: 0,
      at,
    };
  }

  let feed: QueryUnMatchTicketsResponse;
  try {
    feed = await fetchUnMatchedTickets();
  } catch (err) {
    logger.warn(
      "Reconciler",
      `fetchUnMatchedTickets failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      pendingBefore,
      pendingAfter: pendingBefore,
      ticketsAttached: 0,
      observedTicketIds: [],
      orphansPurged: 0,
      at,
    };
  }

  const tickets = feed.geniusSportsUnMatchTickets ?? [];
  const observedTicketIds: string[] = [];
  let ticketsAttached = 0;
  let orphansPurged = 0;
  const nowMs = Date.now();
  // One live book ticket must never be attached to more than one
  // placed_bets row. Without this, a race that produced N duplicate
  // rows for the same (event, market, selection) would all match the
  // single book ticket here and each fire its own Telegram. The DB's
  // new UNIQUE partial index on (event, family, atom) prevents the
  // duplicates going forward, but legacy rows may exist — keep the
  // guard so reconciliation stays idempotent regardless.
  const claimedTicketIds = new Set<string>();
  for (const row of pending) {
    if (row.providerTicketId) claimedTicketIds.add(row.providerTicketId);
  }

  for (const row of pending) {
    const refs = extractRefs(row as PendingBetLike);
    const stake = Number(row.stake);
    const odds = Number(row.odds);
    const placedMs = Date.parse(
      typeof row.placedAt === "string"
        ? row.placedAt
        : row.placedAt
          ? (row.placedAt as unknown as Date).toISOString()
          : String(nowMs),
    );

    const match = findTicketForRow(
      tickets,
      {
        betfairEventId: refs.betfairEventId,
        marketId: refs.marketId,
        selectionId: refs.selectionId,
        stake,
        odds,
        placedAt:
          typeof row.placedAt === "string"
            ? row.placedAt
            : row.placedAt
              ? (row.placedAt as unknown as Date).toISOString()
              : String(nowMs),
      },
      claimedTicketIds,
    );

    if (!match) {
      // Age-out: pending rows the book never surfaced are almost
      // certainly silent failures. Delete them so the dedup unblocks
      // retries. Fresh pendings within the TTL are left alone — the
      // book may still confirm within a few seconds.
      if (nowMs - placedMs > ORPHAN_PENDING_TTL_MS) {
        const deleted = await deleteBet(row.id);
        if (deleted) {
          orphansPurged++;
          logger.warn(
            "Reconciler",
            `purged orphaned pending placed_bet ${row.id} ` +
              `(event ${row.eventId}, stake ${stake}@${odds}, ` +
              `age ${Math.round((nowMs - placedMs) / 1000)}s) — never surfaced in myBets feed`,
          );
        }
      }
      continue;
    }

    const ticketId = String(match.id);
    observedTicketIds.push(ticketId);

    // If the row already has THIS ticket id, nothing to do.
    if (row.providerTicketId === ticketId) continue;

    // If the row has a different ticket id, prefer what the book says
    // (unlikely but defensive — the book is the source of truth).
    const updated = await attachTicketId(row.id, ticketId);
    if (updated) {
      claimedTicketIds.add(ticketId);
      ticketsAttached++;
      logger.info(
        "Reconciler",
        `attached ticket ${ticketId} to placed_bet ${row.id} ` +
          `(event ${row.eventId}, stake ${stake}@${odds})`,
      );
      // Intentionally NO Telegram here. The placement-confirmation path
      // (lib/betting/ninewickets/placement-confirmation.ts) is the
      // authoritative "Bet placed" notifier. Firing a second ping from
      // the reconciler produced duplicate notifications today
      // (tickets 11057135/39/42 for Randers vs Fredericia).
    }
  }

  return {
    pendingBefore,
    pendingAfter: pendingBefore - ticketsAttached - orphansPurged,
    ticketsAttached,
    orphansPurged,
    observedTicketIds,
    at,
  };
}

/**
 * Find the live unmatched ticket matching a given pending row.
 * Matches on (betfairEventId, marketId, selectionId, stake, odds),
 * falling back to a looser 3-field match when the payload didn't
 * preserve all refs.
 *
 * Odds comparison uses a tiny epsilon because the feed rounds to 2 dp
 * but the request may carry more.
 */
function findTicketForRow(
  tickets: GeniusSportsUnMatchTicket[],
  row: {
    betfairEventId: number | null;
    marketId: string | null;
    selectionId: number | null;
    stake: number;
    odds: number;
    placedAt: string;
  },
  claimedTicketIds: Set<string>,
): GeniusSportsUnMatchTicket | null {
  const rowPlacedMs = Date.parse(row.placedAt);
  const oddsEq = (a: number, b: number) => Math.abs(a - b) < 0.005;
  const isClaimed = (t: GeniusSportsUnMatchTicket) =>
    claimedTicketIds.has(String(t.id));

  // Strict: all refs + stake + odds
  for (const t of tickets) {
    if (isClaimed(t)) continue;
    if (row.selectionId !== null && t.selectionId !== row.selectionId) continue;
    if (row.marketId !== null && String(t.marketId) !== row.marketId) continue;
    if (t.initPrice !== row.stake) continue;
    if (!oddsEq(t.odds, row.odds)) continue;
    // Guard: the ticket must have been created at-or-after the row
    // was placed (plus a 5s clock-skew buffer).
    if (t.createDate < rowPlacedMs - 5000) continue;
    return t;
  }

  // Loose: event + stake + odds (used when payload refs weren't saved)
  if (row.betfairEventId !== null) {
    for (const t of tickets) {
      if (isClaimed(t)) continue;
      const sameEvent =
        (t as { mappingEventId?: number }).mappingEventId ===
          row.betfairEventId || t.eventId === row.betfairEventId;
      if (!sameEvent) continue;
      if (t.initPrice !== row.stake) continue;
      if (!oddsEq(t.odds, row.odds)) continue;
      return t;
    }
  }

  return null;
}
