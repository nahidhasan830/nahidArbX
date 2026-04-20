/**
 * Repository for the `placed_bets` table — the durable record of bets
 * we have actually submitted to a book. Settlement outcomes are mirrored
 * here from `value_bets` so this table is self-contained for reporting.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../client";
import { placedBets, type PlacedBetRow } from "../schema";

export type PlacedBetStatus =
  | "pending"
  | "won"
  | "lost"
  | "void"
  | "half_won"
  | "half_lost"
  | "cancelled";

export interface NewPlacedBetInput {
  id: string;
  valueBetId: string | null;
  eventId: string;
  familyId: string;
  atomId: string;
  atomLabel: string;
  eventName: string;
  competition: string | null;
  eventStartTime: string; // ISO
  marketType: string;
  provider: string;
  stake: number;
  odds: number;
  currency: string;
  providerTicketId: string | null;
  mode: "auto" | "manual";
  requestPayload: unknown;
  responsePayload: unknown;
}

/**
 * Sentinel thrown when the partial UNIQUE index on (event_id, family_id,
 * atom_id) rejects an insert. The placer catches this to treat a racing
 * concurrent placement as "already placed" instead of surfacing a 5xx.
 */
export class DuplicatePlacedBetError extends Error {
  constructor(
    readonly eventId: string,
    readonly familyId: string,
    readonly atomId: string,
  ) {
    super(`Placed bet already exists for (${eventId}, ${familyId}, ${atomId})`);
    this.name = "DuplicatePlacedBetError";
  }
}

export async function insertPlacedBet(
  input: NewPlacedBetInput,
): Promise<PlacedBetRow> {
  try {
    const [row] = await db
      .insert(placedBets)
      .values({
        ...input,
        // Explicit null for optional DB columns so Drizzle doesn't try to
        // insert undefined (which triggers a NOT NULL check failure on
        // columns that don't have defaults).
        closingOdds: null,
        clvPct: null,
        pnl: null,
        settledAt: null,
        settledBySource: null,
        error: null,
        outcome: "pending",
        requestPayload: input.requestPayload as never,
        responsePayload: input.responsePayload as never,
      })
      .returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err, "placed_bets_dedup_idx")) {
      throw new DuplicatePlacedBetError(
        input.eventId,
        input.familyId,
        input.atomId,
      );
    }
    throw err;
  }
}

/**
 * Postgres unique-violation error detection. Drizzle surfaces the
 * underlying pg error as `err.cause` with `code='23505'` and
 * `constraint='<index_name>'`.
 */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  const code = e.code ?? e.cause?.code;
  const cons = e.constraint ?? e.cause?.constraint;
  return code === "23505" && (!cons || cons === constraint);
}

/**
 * True iff a placed bet already exists for (eventId, familyId, atomId)
 * on any provider (lifetime dedup across books). Cancelled rows are
 * ignored so a failed placement doesn't block a retry.
 *
 * Note: we no longer write rejected/errored placements to the DB at
 * all (see placer.ts). The `outcome = 'cancelled'` clause here exists
 * for legacy rows and for settlement flows that may void a bet.
 */
export async function isAlreadyPlaced(
  eventId: string,
  familyId: string,
  atomId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: placedBets.id })
    .from(placedBets)
    .where(
      and(
        eq(placedBets.eventId, eventId),
        eq(placedBets.familyId, familyId),
        eq(placedBets.atomId, atomId),
        sql`${placedBets.outcome} <> 'cancelled'`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Fetch a single placed bet by id, or null if not yet inserted. */
export async function getPlacedBetById(
  id: string,
): Promise<PlacedBetRow | null> {
  const [row] = await db
    .select()
    .from(placedBets)
    .where(eq(placedBets.id, id))
    .limit(1);
  return row ?? null;
}

/** Newest-first list of placed bets, capped. */
export async function listPlacedBets(limit = 200): Promise<PlacedBetRow[]> {
  return db
    .select()
    .from(placedBets)
    .orderBy(desc(placedBets.placedAt))
    .limit(limit);
}

/**
 * All currently-pending bets for a provider, newest first. Used by
 * the reconciler to match rows against live unmatched tickets.
 */
export async function listPendingBetsForProvider(
  provider: string,
  limit = 500,
): Promise<PlacedBetRow[]> {
  return db
    .select()
    .from(placedBets)
    .where(
      and(eq(placedBets.provider, provider), eq(placedBets.outcome, "pending")),
    )
    .orderBy(desc(placedBets.placedAt))
    .limit(limit);
}

/**
 * Attach a book-assigned ticket id to a pending row. Used when a
 * placement first went through without a ticket (async processing)
 * and reconciliation later found the corresponding unmatched ticket.
 */
export async function attachTicketId(
  placedBetId: string,
  ticketId: string,
): Promise<PlacedBetRow | null> {
  const [updated] = await db
    .update(placedBets)
    .set({
      providerTicketId: ticketId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(placedBets.id, placedBetId))
    .returning();
  return updated ?? null;
}

/**
 * Delete a placed_bets row by id. Used by the reconciler when a
 * `pending` row has aged out without ever appearing in the book's
 * myBets feed — the placement almost certainly failed silently on the
 * book's side and the DB row would otherwise block a retry via the
 * cross-provider dedup.
 *
 * Returns true iff a row was actually deleted.
 */
export async function deletePlacedBet(placedBetId: string): Promise<boolean> {
  const deleted = await db
    .delete(placedBets)
    .where(eq(placedBets.id, placedBetId))
    .returning({ id: placedBets.id });
  return deleted.length > 0;
}

/** For settlement cascading — find placed bets tied to these value-bet ids. */
export async function findPlacedByValueBetIds(
  valueBetIds: string[],
): Promise<PlacedBetRow[]> {
  if (valueBetIds.length === 0) return [];
  return db
    .select()
    .from(placedBets)
    .where(inArray(placedBets.valueBetId, valueBetIds));
}

/**
 * Mirror a settlement outcome from value_bets onto a placed_bet and
 * compute its realised P&L. Returns the updated row, or null if the
 * id doesn't exist / was already settled to the same outcome (no-op).
 */
export async function applySettlementToPlaced(args: {
  placedBetId: string;
  outcome: Exclude<PlacedBetStatus, "pending" | "cancelled">;
  settledBySource: string | null;
  closingOdds: number | null;
  closingSharpOdds: number | null;
}): Promise<PlacedBetRow | null> {
  const current = await db
    .select()
    .from(placedBets)
    .where(eq(placedBets.id, args.placedBetId))
    .limit(1);
  const row = current[0];
  if (!row || row.outcome === args.outcome) return null;

  const pnl = computePnl(Number(row.stake), Number(row.odds), args.outcome);
  const clvPct =
    args.closingOdds && row.odds
      ? (Number(row.odds) / args.closingOdds - 1) * 100
      : null;

  const [updated] = await db
    .update(placedBets)
    .set({
      outcome: args.outcome,
      settledAt: new Date().toISOString(),
      settledBySource: args.settledBySource,
      closingOdds: args.closingOdds ?? null,
      clvPct: clvPct !== null ? Number(clvPct.toFixed(2)) : null,
      pnl: Number(pnl.toFixed(2)),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(placedBets.id, args.placedBetId))
    .returning();
  return updated ?? null;
}

function computePnl(
  stake: number,
  odds: number,
  outcome: Exclude<PlacedBetStatus, "pending" | "cancelled">,
): number {
  switch (outcome) {
    case "won":
      return stake * (odds - 1);
    case "half_won":
      return (stake * (odds - 1)) / 2;
    case "lost":
      return -stake;
    case "half_lost":
      return -stake / 2;
    case "void":
      return 0;
  }
}
