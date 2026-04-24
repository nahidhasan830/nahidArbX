/**
 * GET /api/betting-accounts/recent-bets
 *
 * Returns a unified 7-day bet feed sourced DIRECTLY from the 9W
 * main-site (not just from our `bets` table) so it reflects the
 * operator's true book activity — including bets placed outside our
 * system.
 *
 * Data plane:
 *   1. `generateSettledBetsSummary` (queryDay=7) — one row per
 *      (settleDate, vendorId, gameTypeId) with aggregate profit/
 *      turnover. Tells us WHICH (day, vendor) tuples have bets.
 *   2. For each tuple with records, `generateSettledBetsDetail`
 *      (queryDate, vendorId, gameTypeId) — per-bet rows.
 *   3. `generateUnsettledBetsDetail` — live pending bets.
 *
 * The UI uses this to power the per-account carousel card's "Recent
 * bets" strip + the modal that opens when the operator taps "+N more".
 */
import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { getSession } from "@/lib/betting/ninewickets/session";
import { mainSiteFetchJson } from "@/lib/betting/ninewickets/main-site-client";
import { isMainSiteOk } from "@/lib/betting/ninewickets/main-site-types";
import type {
  SettledBetsSummaryResponse,
  SettledBetsDetailResponse,
  UnsettledBetsDetailResponse,
  SettledBetDetailRecord,
  UnsettledBetDetailRecord,
  BetReportTotals,
} from "@/lib/betting/ninewickets/main-site-types";
import { fetchUnMatchedTickets } from "@/lib/betting/ninewickets/reconciler";
import type { GeniusSportsUnMatchTicket } from "@/lib/betting/ninewickets/types";
import { db } from "@/lib/db/client";
import { bets } from "@/lib/db/schema";
import { logger } from "@/lib/shared/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PERIOD_DAYS = 7;
const PAGE_SIZE = 20;
const DETAIL_REFERER = "https://9wktsbest.com/bd/en/member/betting-records";

/**
 * Unified bet-feed row. Settled + unsettled bets coexist so the UI can
 * render a single timeline; consumers distinguish via `status`.
 */
/**
 * Extra fields attached to a main-site bet when we can match it back to
 * a row in our `bets` table (matched via providerTicketId ↔
 * vendorTxnId / transactionId). The UI uses these to show richer labels
 * (home vs away team, explicit selection, normalized market type) instead
 * of falling back to the main-site's generic gameName / betType pair.
 *
 * All fields are optional — for bets placed outside our system the
 * enrichment block is absent and the UI shows main-site fields.
 */
export interface RecentBetEnrichment {
  placedBetId?: string;
  valueBetId?: string;
  eventName?: string;
  homeTeam?: string;
  awayTeam?: string;
  competition?: string;
  marketType?: string;
  atomLabel?: string;
}

export interface RecentBet {
  id: string;
  status: "settled" | "pending";
  placedAt: string; // ISO
  settledAt?: string; // ISO, settled only
  vendorId: number;
  vendorName: string;
  gameName: string;
  gameTypeId: number;
  stake: number;
  odds: number;
  profit?: number; // settled only
  turnover?: number;
  result?: "win" | "lose" | "void"; // settled only; "void" included for future-proofing
  betType: string;
  transactionId: number;
  vendorTxnId: string;
  enrichment?: RecentBetEnrichment;
}

interface RecentBetsResponse {
  periodDays: number;
  bets: RecentBet[];
  totals: BetReportTotals & {
    pendingCount: number;
    settledCount: number;
  };
  at: string;
  errors: Record<string, string>;
}

export async function GET() {
  const session = await getSession();
  const at = new Date().toISOString();
  const errors: Record<string, string> = {};

  if (!session.accessToken) {
    return NextResponse.json(
      {
        periodDays: PERIOD_DAYS,
        bets: [],
        totals: {
          totalProfitLoss: null,
          totalTurnover: null,
          totalBetAmount: null,
          pendingCount: 0,
          settledCount: 0,
        },
        at,
        errors: { session: "No main-site JWT — log in via Betjili first" },
      } satisfies RecentBetsResponse,
      { status: 200 },
    );
  }

  // ── Step 1: summary (identifies which days/vendors had bets) ──────
  const tuples: Array<{
    settleDate: string;
    vendorId: number;
    gameTypeId: number;
  }> = [];
  try {
    const summary = await mainSiteFetchJson<SettledBetsSummaryResponse>({
      method: "POST",
      path: "/api/bt/v1/report/generateSettledBetsSummary",
      jwt: session.accessToken,
      referer: DETAIL_REFERER,
      body: {
        languageTypeId: 1,
        currencyTypeId: 8,
        vendorIds: [],
        gameTypeIds: [],
        queryDay: PERIOD_DAYS,
        currentPage: 1,
        pageSize: PAGE_SIZE,
      },
    });
    if (summary.status !== "000000") {
      errors.summary = `${summary.status} ${summary.message}`;
    } else {
      for (const r of summary.data.records) {
        tuples.push({
          settleDate: r.summaryDate,
          vendorId: r.vendorId,
          gameTypeId: r.gameTypeId,
        });
      }
    }
  } catch (err) {
    errors.summary = err instanceof Error ? err.message : String(err);
  }

  // ── Step 2: per-tuple detail, in parallel ─────────────────────────
  const settledBets: RecentBet[] = [];
  const detailResults = await Promise.allSettled(
    tuples.map(async (t) => {
      const detail = await mainSiteFetchJson<SettledBetsDetailResponse>({
        method: "POST",
        path: "/api/bt/v1/report/generateSettledBetsDetail",
        jwt: session.accessToken!,
        referer: DETAIL_REFERER,
        body: {
          languageTypeId: 1,
          currencyTypeId: 8,
          vendorId: t.vendorId,
          gameTypeId: t.gameTypeId,
          queryDate: t.settleDate,
          currentPage: 1,
          pageSize: PAGE_SIZE,
        },
      });
      if (detail.status !== "000000") {
        throw new Error(`${detail.status} ${detail.message}`);
      }
      return detail.data.records;
    }),
  );
  for (const [i, r] of detailResults.entries()) {
    if (r.status === "fulfilled") {
      r.value.forEach((rec, idx) => {
        settledBets.push(normalizeSettled(rec, idx));
      });
    } else {
      const t = tuples[i];
      const key = `detail:${t.vendorId}:${t.settleDate}`;
      errors[key] =
        r.reason instanceof Error ? r.reason.message : String(r.reason);
      logger.warn("RecentBetsAPI", "detail fetch failed", {
        tuple: t,
        error: errors[key],
      });
    }
  }

  // ── Step 3: unsettled / pending ────────────────────────────────────
  //
  // Two sources, joined:
  //   a) Main-site /generateUnsettledBetsDetail  — covers EVERY product
  //      (casino, slots, live, sportsbook) but for 9W Sportsbook bets
  //      it returns only `stake` + `gameName: "S/G SOCCER"`; every
  //      other field (vendorTxnId, transactionId, odds, betType) is
  //      null. Useless for display on its own.
  //   b) Exchange host  queryUnMatchTicketsAndTxns  — returns rich
  //      per-ticket data for sportsbook specifically: eventName,
  //      marketName, selectionName, odds, stake, ticket id, placedAt.
  //
  // Strategy: drop every main-site pending row whose vendor maps to
  // the sportsbook (vendorName includes "exchange"/"sportsbook" or the
  // entire row is a null stub), and replace them with one row per
  // GeniusSportsUnMatchTicket. Non-sportsbook products (casino, etc.)
  // still come from main-site since the exchange feed doesn't cover
  // them. This way the operator sees team + market + selection +
  // odds for sportsbook bets regardless of whether they were placed
  // through our system or directly on 9W.
  const pendingBets: RecentBet[] = [];
  try {
    const unsettled = await mainSiteFetchJson<UnsettledBetsDetailResponse>({
      method: "POST",
      path: "/api/bt/v1/report/generateUnsettledBetsDetail",
      jwt: session.accessToken,
      referer: DETAIL_REFERER,
      body: {
        languageTypeId: 1,
        currencyTypeId: 8,
        vendorIds: [],
        gameTypeIds: [],
        queryDay: PERIOD_DAYS,
        currentPage: 1,
        pageSize: PAGE_SIZE,
      },
    });
    if (unsettled.status !== "000000") {
      errors.unsettled = `${unsettled.status} ${unsettled.message}`;
    } else {
      unsettled.data.records.forEach((rec, idx) => {
        if (isSportsbookVendor(rec.vendorName, rec.gameName)) return;
        pendingBets.push(normalizeUnsettled(rec, idx));
      });
    }
  } catch (err) {
    errors.unsettled = err instanceof Error ? err.message : String(err);
  }

  // Sportsbook pending bets via the exchange-host feed. The same feed
  // also carries `geniusSportsTxns` — matched/settled transactions
  // with rich eventName / marketName / selectionName fields keyed by
  // `betId` ↔ pending-ticket `id`. We keep that map around for the
  // settled-side enrichment below.
  const sportsbookTxnById = new Map<
    string,
    { eventName: string; marketName: string; selectionName: string }
  >();
  try {
    const feed = await fetchUnMatchedTickets();
    const tickets: GeniusSportsUnMatchTicket[] =
      feed.geniusSportsUnMatchTickets ?? [];
    tickets.forEach((t, idx) => {
      pendingBets.push(normalizeSportsbookTicket(t, idx));
    });
    for (const txn of feed.geniusSportsTxns ?? []) {
      // `betId` is the ticket id from `geniusSportsUnMatchTickets.id`.
      // Keyed as string so we can look it up directly from a main-site
      // vendorTxnId after stripping the "SB" prefix.
      const ticketKey =
        typeof txn.betId === "number" || typeof txn.betId === "string"
          ? String(txn.betId)
          : null;
      const en = typeof txn.eventName === "string" ? txn.eventName : null;
      const mn = typeof txn.marketName === "string" ? txn.marketName : null;
      const sn =
        typeof txn.selectionName === "string" ? txn.selectionName : null;
      if (ticketKey && en && mn && sn) {
        sportsbookTxnById.set(ticketKey, {
          eventName: en,
          marketName: mn,
          selectionName: sn,
        });
      }
    }
  } catch (err) {
    errors.sportsbookPending = err instanceof Error ? err.message : String(err);
    logger.warn("RecentBetsAPI", "sportsbook pending fetch failed", {
      error: errors.sportsbookPending,
    });
  }

  // Merge + sort (newest first). Pending bets are effectively "now" —
  // placed but still in-flight — so they float above same-second
  // settled bets by tie-breaking on status.
  const all = [...pendingBets, ...settledBets].sort((a, b) => {
    const ta = Date.parse(a.placedAt);
    const tb = Date.parse(b.placedAt);
    return tb - ta;
  });

  // ── Enrichment: join against the unified bets table for richer display fields.
  //
  // For any bet we also placed through our system, pull the event name,
  // selection label, market type, and home/away team directly from `bets`.
  // Non-matches simply skip — the UI falls back to main-site fields.
  //
  // Match key: `bets.providerTicketId` is set by the reconciler
  // to the book's ticket id, which shows up here as either
  // `vendorTxnId` (string) or `transactionId` (number). We probe both.
  try {
    // Build the candidate ticket-id set. Main-site settled rows carry
    // vendorTxnId like "SB11034330" — the "SB"/"EX" prefix identifies
    // the vendor but the numeric suffix is the Genius Sports ticket id
    // we stored as `bets.provider_ticket_id`. We probe both the
    // verbatim string AND the stripped suffix so the join succeeds
    // regardless of which format a given adapter persisted.
    const ticketIds = new Set<string>();
    for (const b of all) {
      if (b.vendorTxnId) {
        ticketIds.add(b.vendorTxnId);
        const stripped = stripVendorPrefix(b.vendorTxnId);
        if (stripped) ticketIds.add(stripped);
      }
      if (b.transactionId !== undefined && b.transactionId !== null) {
        ticketIds.add(String(b.transactionId));
      }
    }
    if (ticketIds.size > 0) {
      const placedRows = await db
        .select()
        .from(bets)
        .where(inArray(bets.providerTicketId, [...ticketIds]));

      const placedByTicket = new Map<string, (typeof placedRows)[number]>();
      for (const p of placedRows) {
        if (p.providerTicketId) placedByTicket.set(p.providerTicketId, p);
      }

      // In merged schema, homeTeam/awayTeam/competition are directly on bet row.
      // No second hop needed.

      for (const bet of all) {
        const stripped = bet.vendorTxnId
          ? stripVendorPrefix(bet.vendorTxnId)
          : null;
        const placed =
          (bet.vendorTxnId && placedByTicket.get(bet.vendorTxnId)) ||
          (stripped && placedByTicket.get(stripped)) ||
          (bet.transactionId !== undefined && bet.transactionId !== null
            ? placedByTicket.get(String(bet.transactionId))
            : undefined);
        if (!placed) continue;
        bet.enrichment = {
          placedBetId: placed.id,
          valueBetId: placed.id, // In merged schema, id IS the valueBetId
          eventName: `${placed.homeTeam} vs ${placed.awayTeam}`,
          marketType: placed.marketType,
          atomLabel: placed.atomLabel,
          competition: placed.competition ?? undefined,
          homeTeam: placed.homeTeam,
          awayTeam: placed.awayTeam,
        };
      }
    }
  } catch (err) {
    // Enrichment is best-effort — a DB hiccup must not break the card.
    errors.enrichment = err instanceof Error ? err.message : String(err);
    logger.warn("RecentBetsAPI", "enrichment failed", {
      error: errors.enrichment,
    });
  }

  // ── Sportsbook-feed fallback for settled bets ─────────────────────
  // Main-site /generateSettledBetsDetail returns only `gameName` +
  // `betType` for sportsbook rows — no team, market, or selection.
  // When the placed_bets join above didn't produce a match (bet was
  // placed outside our system or the ticket id never got persisted),
  // fall back to the `geniusSportsTxns` map we built from the exchange
  // feed. That covers recently-matched sportsbook tickets with full
  // eventName / marketName / selectionName triples.
  if (sportsbookTxnById.size > 0) {
    for (const bet of all) {
      if (bet.enrichment?.eventName) continue;
      const candidates: string[] = [];
      if (bet.vendorTxnId) {
        candidates.push(bet.vendorTxnId);
        const stripped = stripVendorPrefix(bet.vendorTxnId);
        if (stripped) candidates.push(stripped);
      }
      if (bet.transactionId !== undefined && bet.transactionId !== null) {
        candidates.push(String(bet.transactionId));
      }
      for (const key of candidates) {
        const hit = sportsbookTxnById.get(key);
        if (hit) {
          bet.enrichment = {
            ...(bet.enrichment ?? {}),
            eventName: hit.eventName,
            marketType: hit.marketName,
            atomLabel: hit.selectionName,
          };
          break;
        }
      }
    }
  }

  const totalProfitLoss = settledBets.reduce((s, b) => s + (b.profit ?? 0), 0);
  const totalTurnover = settledBets.reduce((s, b) => s + (b.turnover ?? 0), 0);
  const totalBetAmount = [...settledBets, ...pendingBets].reduce(
    (s, b) => s + b.stake,
    0,
  );

  const resp: RecentBetsResponse = {
    periodDays: PERIOD_DAYS,
    bets: all,
    totals: {
      totalProfitLoss: Number.isFinite(totalProfitLoss)
        ? totalProfitLoss
        : null,
      totalTurnover: Number.isFinite(totalTurnover) ? totalTurnover : null,
      totalBetAmount: Number.isFinite(totalBetAmount) ? totalBetAmount : null,
      pendingCount: pendingBets.length,
      settledCount: settledBets.length,
    },
    at,
    errors,
  };
  return NextResponse.json(resp);
}

// The main-site API sometimes returns records with no transactionId
// (notably pending bets). Fall back to vendorTxnId, then to a composite
// index so React keys stay unique — the typed `number` is optimistic.
function stableBetId(
  status: "settled" | "pending",
  rec: { transactionId?: number; vendorTxnId?: string },
  idx: number,
): string {
  if (rec.transactionId !== undefined && rec.transactionId !== null)
    return `${status}:${rec.transactionId}`;
  if (rec.vendorTxnId) return `${status}:v:${rec.vendorTxnId}`;
  return `${status}:idx:${idx}`;
}

function normalizeSettled(rec: SettledBetDetailRecord, idx: number): RecentBet {
  return {
    id: stableBetId("settled", rec, idx),
    status: "settled",
    placedAt: new Date(rec.txnTimestamp).toISOString(),
    settledAt: new Date(rec.settleTimestamp).toISOString(),
    vendorId: rec.vendorId,
    vendorName: rec.vendorName,
    gameName: rec.gameName,
    gameTypeId: rec.gameTypeId,
    stake: rec.betAmount,
    odds: rec.odds,
    profit: rec.profit,
    turnover: rec.turnover,
    result:
      rec.betResult === "win" || rec.betResult === "lose"
        ? rec.betResult
        : "void",
    betType: rec.betType,
    transactionId: rec.transactionId,
    vendorTxnId: rec.vendorTxnId,
  };
}

function normalizeUnsettled(
  rec: UnsettledBetDetailRecord,
  idx: number,
): RecentBet {
  return {
    id: stableBetId("pending", rec, idx),
    status: "pending",
    placedAt: new Date(rec.txnTimestamp).toISOString(),
    vendorId: rec.vendorId,
    vendorName: rec.vendorName,
    gameName: rec.gameName,
    gameTypeId: rec.gameTypeId,
    stake: rec.betAmount,
    odds: rec.odds,
    turnover: rec.turnover,
    betType: rec.betType,
    transactionId: rec.transactionId,
    vendorTxnId: rec.vendorTxnId,
  };
}

/**
 * Turn one exchange-host unmatched ticket into a unified RecentBet.
 * This is the authoritative shape for 9W-Sportsbook pending bets — we
 * carry eventName / marketName / selectionName through the enrichment
 * block so the UI renders team vs team + market + selection without
 * any DB join. A placed_bets lookup may still overwrite these fields
 * later in the enrichment pass with the value_bets team names.
 */
function normalizeSportsbookTicket(
  t: GeniusSportsUnMatchTicket,
  idx: number,
): RecentBet {
  const ticketId = String(t.id);
  return {
    id: `pending:sb:${ticketId || idx}`,
    status: "pending",
    placedAt: new Date(t.createDate).toISOString(),
    // 9W's vendor id / name for the sportsbook aren't attached to the
    // exchange-feed record, but we know them from the product family.
    vendorId: -1,
    vendorName: "Exchange",
    gameName: t.eventName || "S/G SOCCER",
    gameTypeId: t.eventType ?? 1,
    stake: t.initPrice,
    odds: t.odds,
    turnover: undefined,
    betType: t.marketName ?? "Sportsbook",
    transactionId: t.id,
    vendorTxnId: ticketId,
    enrichment: {
      eventName: t.eventName,
      marketType: t.marketName,
      atomLabel: t.selectionName,
    },
  };
}

/**
 * True for 9W main-site pending rows whose vendor corresponds to the
 * Genius Sports sportsbook. We drop those rows entirely before adding
 * the richer exchange-feed equivalents — the main-site version of a
 * sportsbook pending bet has no usable fields (stake + gameName only).
 */
function isSportsbookVendor(
  vendorName: string | null | undefined,
  gameName: string | null | undefined,
): boolean {
  const v = (vendorName ?? "").toLowerCase();
  const g = (gameName ?? "").toLowerCase();
  return (
    v === "exchange" ||
    v.includes("sportsbook") ||
    v.includes("s/g") ||
    g.includes("s/g") ||
    g.includes("sportsbook")
  );
}

/**
 * Vendor-prefixed transaction ids on the main-site feed look like
 * "SB11034330" or "EX982374". Strip the two-letter prefix so we can
 * match against `placed_bets.provider_ticket_id`, which stores the
 * bare numeric ticket id as returned by the book's placement API.
 * Returns null when the input isn't a recognisable prefixed id.
 */
function stripVendorPrefix(vendorTxnId: string): string | null {
  const m = /^[A-Z]{1,3}(\d+)$/.exec(vendorTxnId);
  return m ? m[1] : null;
}
