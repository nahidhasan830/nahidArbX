/**
 * Velki pending-bet reconciler.
 *
 * Symmetric counterpart to {@link ../ninewickets/reconciler.ts}. Both
 * providers run the same Genius Sports platform, so the feed endpoint
 * (`queryUnMatchTicketsAndTxns`) returns the exact same response shape
 * — only the host and auth differ.
 *
 * All monetary amounts in the raw feed are in Velki-units (1 = 100 BDT).
 * This module normalizes them to plain BDT at the boundary, so every
 * downstream consumer sees the same denomination as the rest of the app.
 */
import { callWithSessionRetry, VelkiSessionExpiredError } from "./session";
import { toBDT } from "./units";
import {
  attachTicketId,
  deleteBet,
  listPendingBetsForProvider,
} from "@/lib/db/repositories/bets";
import { logger } from "@/lib/shared/logger";
import type {
  GeniusSportsUnMatchTicket,
  QueryUnMatchTicketsResponse,
} from "../ninewickets/types";

const PROVIDER_API_HOST = "https://saapipl.fwick7ets.xyz";
const PROVIDER_WEB_ORIGIN = "https://www.fwick7ets.xyz";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: PROVIDER_WEB_ORIGIN,
  Referer: `${PROVIDER_WEB_ORIGIN}/`,
  "sec-ch-ua": '"Chromium";v="147", "Not.A/Brand";v="8", "Brave";v="147"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-site",
  source: "1",
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
 * Normalize monetary amounts on a single ticket from Velki-units to BDT.
 * Odds, ids, and timestamps are left untouched.
 */
function normalizeTicketAmounts(
  t: GeniusSportsUnMatchTicket,
): GeniusSportsUnMatchTicket {
  return {
    ...t,
    initPrice: toBDT(t.initPrice),
    lastPrice: toBDT(t.lastPrice),
    cancelPrice: toBDT(t.cancelPrice),
  };
}

/**
 * Fetch the live unmatched-tickets + transaction feed from Velki's
 * provider tier. All monetary amounts in the returned tickets are
 * normalized to plain BDT.
 */
export async function fetchUnMatchedTickets(): Promise<QueryUnMatchTicketsResponse> {
  return callWithSessionRetry(async (session) => {
    const url = `${PROVIDER_API_HOST}/exchange/member/playerService/queryUnMatchTicketsAndTxns;jsessionid=${session.jsessionid}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: session.jsessionid,
        Cookie: `JSESSIONID=${session.jsessionid}`,
      },
      body: new URLSearchParams(UNMATCH_FIELDS).toString(),
    });
    if (res.status === 401 || res.status === 403) {
      throw new VelkiSessionExpiredError(`queryUnMatch ${res.status}`);
    }
    const text = await res.text();
    const trimmed = text.trim();
    if (trimmed.startsWith("<")) {
      throw new VelkiSessionExpiredError("queryUnMatch returned HTML");
    }
    if (trimmed.length === 0) {
      throw new VelkiSessionExpiredError("queryUnMatch returned empty body");
    }
    const parsed = JSON.parse(trimmed) as
      | QueryUnMatchTicketsResponse
      | { status?: string; message?: string };
    const statusVal = (parsed as { status?: unknown }).status;
    if (typeof statusVal === "string" && statusVal !== "0") {
      const envelope = parsed as { status: string; message?: string };
      throw new VelkiSessionExpiredError(
        `queryUnMatch error envelope: ${envelope.status} ${envelope.message ?? ""}`,
      );
    }
    const feed = parsed as QueryUnMatchTicketsResponse;
    // Normalize Velki-unit amounts to BDT on all GS tickets so
    // downstream matching / DB writes use the same denomination as
    // the rest of the app.
    feed.geniusSportsUnMatchTickets = (
      feed.geniusSportsUnMatchTickets ?? []
    ).map(normalizeTicketAmounts);
    return feed;
  });
}

// =====================================================================
// Pending-bet reconciler (mirrors ninewickets/reconciler.ts)
// =====================================================================

const ORPHAN_PENDING_TTL_MS = 5 * 60 * 1000;

export interface ReconcileReport {
  pendingBefore: number;
  pendingAfter: number;
  ticketsAttached: number;
  observedTicketIds: string[];
  orphansPurged: number;
  at: string;
}

export async function reconcilePendingBets(): Promise<ReconcileReport> {
  const provider = "velki-sportsbook";
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
      "Velki.Reconciler",
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
  const claimedTicketIds = new Set<string>();
  for (const row of pending) {
    if (row.providerTicketId) claimedTicketIds.add(row.providerTicketId);
  }

  for (const row of pending) {
    // If the row already has a ticket id, verify it's still in the live feed.
    // The provider's bet history is the ultimate source of truth.
    if (row.providerTicketId) {
      const stillInFeed = tickets.some(t => String(t.id) === row.providerTicketId);
      if (!stillInFeed) {
        const placedMs = Date.parse(row.placedAt as string);
        if (nowMs - placedMs > ORPHAN_PENDING_TTL_MS) {
          logger.warn(
            "VelkiReconciler",
            `Pending bet ${row.id} (ticket ${row.providerTicketId}) vanished from open feed after 5m. Assumed rejected/void. Deleting to allow retry.`,
          );
          await deleteBet(row.id);
          orphansPurged++;
        }
      }
      continue;
    }

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
      if (nowMs - placedMs > ORPHAN_PENDING_TTL_MS) {
        const deleted = await deleteBet(row.id);
        if (deleted) {
          orphansPurged++;
          logger.warn(
            "Velki.Reconciler",
            `purged orphaned pending bet ${row.id} ` +
              `(event ${row.eventId}, stake ${stake}@${odds}, ` +
              `age ${Math.round((nowMs - placedMs) / 1000)}s) — never surfaced in feed`,
          );
        }
      }
      continue;
    }

    const ticketId = String(match.id);
    observedTicketIds.push(ticketId);
    if (row.providerTicketId === ticketId) continue;

    const updated = await attachTicketId(row.id, ticketId);
    if (updated) {
      claimedTicketIds.add(ticketId);
      ticketsAttached++;
      logger.info(
        "Velki.Reconciler",
        `attached ticket ${ticketId} to bet ${row.id} ` +
          `(event ${row.eventId}, stake ${stake}@${odds})`,
      );
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

function findTicketForRow(
  tickets: GeniusSportsUnMatchTicket[],
  row: {
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

  for (const t of tickets) {
    if (isClaimed(t)) continue;
    if (t.initPrice !== row.stake) continue;
    if (!oddsEq(t.odds, row.odds)) continue;
    if (t.createDate < rowPlacedMs - 5000) continue;
    return t;
  }

  return null;
}
