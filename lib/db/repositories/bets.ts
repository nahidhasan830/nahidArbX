/**
 * Repository for the unified `bets` table — merges the former value_bets
 * and placed_bets.
 *
 * Key design:
 * - All fields from both tables are now in one place.
 * - Placement fields (placedAt, provider, stake, odds, etc.) are NULL
 *   until a bet is actually placed.
 * - Queries for "placed bets only" use: WHERE placedAt IS NOT NULL
 * - Queries for "unmatched opportunities" use: WHERE placedAt IS NULL
 * - Manual bets: WHERE mode = 'manual'
 * - Auto bets: WHERE mode = 'auto'
 *
 * The settlement cascade (value_bets → placed_bets) is no longer needed
 * since outcome lives on the same row.
 */
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../client";
import { bets, type BetRow } from "../schema";
import { getEvent } from "@/lib/store";
import { getFamily } from "@/lib/atoms/registry";
import { logger } from "@/lib/shared/logger";
import { normalizeOutcome, type Outcome } from "@/lib/bets-history/types";
import { formatAtomLabel } from "@/lib/formatting/labels";
import { getBettingSettings } from "./betting-settings";

// ─── Type re-exports for backwards compatibility ────────────────────────────────

export type { BetRow as ValueBetRow };
export type PersistResult = {
  attempted: number;
  inserted: number;
  updated: number;
  skippedNoEvent: number;
  skippedNoFamily: number;
  errors: number;
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

const toIso = (d: Date | string | number): string =>
  typeof d === "string" ? d : new Date(d).toISOString();

// ─── Persist (upsert from value detection pipeline) ────────────────────────────

export const persistValueBets = async (
  betsToPersist: Array<{
    id: string;
    eventId: string;
    familyId: string;
    atomId: string;
    sharpProvider: string;
    sharpOdds: number;
    trueProb: number;
    sharpOddsAgeMs: number | null;
    softProvider: string;
    commissionPct: number;
    softOdds: number;
    detectedAt: Date | string | number;
    /** Optimisation (Phase 3): live-strategy id that claimed this detection. */
    strategyId?: string | null;
  }>,
): Promise<PersistResult> => {
  const result: PersistResult = {
    attempted: betsToPersist.length,
    inserted: 0,
    updated: 0,
    skippedNoEvent: 0,
    skippedNoFamily: 0,
    errors: 0,
  };

  for (const vb of betsToPersist) {
    const event = getEvent(vb.eventId);
    if (!event) {
      result.skippedNoEvent++;
      logger.warn(
        "BetPersist",
        `Skip ${vb.id}: event ${vb.eventId} not in store`,
      );
      continue;
    }
    const family = getFamily(vb.familyId);
    if (!family) {
      result.skippedNoFamily++;
      logger.warn(
        "BetPersist",
        `Skip ${vb.id}: family ${vb.familyId} not in registry`,
      );
      continue;
    }

    // Dedup invariant: bet id MUST be `${eventId}|${familyId}|${atomId}`.
    // Coerce even if the caller passed something else — the PK is our
    // single source of truth for "one row per selection".
    const deterministicId = `${vb.eventId}|${vb.familyId}|${vb.atomId}`;
    if (vb.id !== deterministicId) {
      logger.warn(
        "BetPersist",
        `Non-deterministic id ${vb.id} — coercing to ${deterministicId}`,
      );
    }

    const detectedIso = toIso(vb.detectedAt ?? new Date());
    const payload = {
      id: deterministicId,
      eventId: vb.eventId,
      familyId: vb.familyId,
      atomId: vb.atomId,
      atomLabel: formatAtomLabel(vb.atomId),
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      competition: event.competition ?? null,
      eventStartTime: toIso(event.startTime),
      marketType: family.market_type,
      timeScope: family.time_scope,
      familyLine: family.line ?? null,
      sharpProvider: vb.sharpProvider,
      sharpOdds: vb.sharpOdds,
      sharpTrueProb: vb.trueProb,
      sharpOddsAgeMs: vb.sharpOddsAgeMs,
      softProvider: vb.softProvider,
      softCommissionPct: vb.commissionPct,
      softOdds: vb.softOdds,
      firstSeenAt: detectedIso,
      lastSeenAt: detectedIso,
      tickCount: 1,
      // Optimisation attribution — null when no live strategy matched.
      strategyId: vb.strategyId ?? null,
      // Placement fields remain NULL for newly detected opportunities
      outcome: "pending" as const,
    };

    try {
      const newPayout = sql`(1 + (${vb.softOdds} - 1) * (1 - ${vb.commissionPct} / 100.0))`;
      const oldPayout = sql`(1 + (${bets.softOdds} - 1) * (1 - ${bets.softCommissionPct} / 100.0))`;
      const rows = await db
        .insert(bets)
        .values(payload)
        .onConflictDoUpdate({
          target: bets.id,
          set: {
            lastSeenAt: detectedIso,
            // Track the best soft odds seen so far (by effective payout after commission)
            softOdds: sql`CASE WHEN ${newPayout} > ${oldPayout} THEN ${vb.softOdds} ELSE ${bets.softOdds} END`,
            softProvider: sql`CASE WHEN ${newPayout} > ${oldPayout} THEN ${vb.softProvider} ELSE ${bets.softProvider} END`,
            softCommissionPct: sql`CASE WHEN ${newPayout} > ${oldPayout} THEN ${vb.commissionPct} ELSE ${bets.softCommissionPct} END`,
            // Sharp side tracks current Pinnacle read
            sharpOdds: vb.sharpOdds,
            sharpTrueProb: vb.trueProb,
            sharpOddsAgeMs: vb.sharpOddsAgeMs,
            tickCount: sql`${bets.tickCount} + 1`,
            // Late-attribute: if the row was previously detected with no
            // live strategy and one is live now, claim it. If the row was
            // already attributed to a strategy, keep that — first claim wins.
            strategyId: sql`COALESCE(${bets.strategyId}, ${vb.strategyId ?? null})`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ tick: bets.tickCount });
      if (rows[0]?.tick === 1) result.inserted++;
      else result.updated++;
    } catch (err) {
      result.errors++;
      const e = err as Error & {
        code?: string;
        detail?: string;
        column?: string;
        constraint?: string;
        cause?: { message?: string; code?: string; detail?: string };
      };
      const causeMsg =
        e.cause?.message ?? e.cause?.detail ?? e.cause?.code ?? null;
      const meta = [
        e.code && `code=${e.code}`,
        e.column && `column=${e.column}`,
        e.constraint && `constraint=${e.constraint}`,
        e.detail && `detail=${e.detail}`,
        causeMsg && `cause=${causeMsg}`,
      ]
        .filter(Boolean)
        .join(" ");
      logger.error(
        "BetPersist",
        `Upsert failed for ${vb.id}: ${e.message}${meta ? ` | ${meta}` : ""}`,
      );
    }
  }

  return result;
};

// ─── List filters ─────────────────────────────────────────────────────────────

export type ListFilters = {
  /** Captured-time lower bound (filters firstSeenAt). */
  from?: string;
  /** Captured-time upper bound (filters firstSeenAt). */
  to?: string;
  /** Kickoff-time lower bound (filters eventStartTime). */
  eventFrom?: string;
  /** Kickoff-time upper bound (filters eventStartTime). */
  eventTo?: string;
  marketTypes?: string[];
  softProviders?: string[];
  outcome?: Outcome | "settled" | "unsettled";
  settledBySources?: string[];
  minEv?: number;
  maxEv?: number;
  search?: string;
  readyToSettle?: boolean;
  /** Bets the pipeline tried to settle but couldn't (`outcome='pending' AND settle_attempts > 0`). */
  needsReview?: boolean;
  /** Only include bets that have been placed. */
  placedOnly?: boolean;
  /**
   * When true, exclude historical in-play pollution — rows where the bet was
   * first detected at or after kickoff. Platform is pre-match only.
   */
  preMatchOnly?: boolean;
  /** Filter bets whose soft (bookmaker) odds are ≥ this value. */
  oddsMin?: number;
  /** Filter bets whose soft (bookmaker) odds are ≤ this value. */
  oddsMax?: number;
  limit?: number;
  offset?: number;
};

// SQL expression for EV% computed at detection price (softOdds). Kept in sync
// with derive.evPctFirst — if the formula changes there, mirror it here.
const evExpr = sql`((1 + (${bets.softOdds} - 1) * (1 - ${bets.softCommissionPct} / 100)) * ${bets.sharpTrueProb} - 1) * 100`;

// Shared filter-clause builder. Kept private so `listBets` and `aggregateBets`
// always apply identical predicates — the toolbar's summary numbers would lie
// otherwise.
const buildFilterClauses = (filters: ListFilters) => {
  const clauses = [];
  if (filters.from) clauses.push(gte(bets.firstSeenAt, filters.from));
  if (filters.to) clauses.push(lte(bets.firstSeenAt, filters.to));
  if (filters.eventFrom)
    clauses.push(gte(bets.eventStartTime, filters.eventFrom));
  if (filters.eventTo) clauses.push(lte(bets.eventStartTime, filters.eventTo));
  if (filters.marketTypes?.length) {
    clauses.push(inArray(bets.marketType, filters.marketTypes));
  }
  if (filters.softProviders?.length) {
    clauses.push(inArray(bets.softProvider, filters.softProviders));
  }
  if (filters.settledBySources?.length) {
    clauses.push(inArray(bets.settledBySource, filters.settledBySources));
  }
  if (filters.outcome) {
    if (filters.outcome === "settled") {
      clauses.push(sql`${bets.outcome} <> 'pending'`);
    } else if (filters.outcome === "unsettled") {
      clauses.push(eq(bets.outcome, "pending"));
    } else {
      clauses.push(eq(bets.outcome, filters.outcome));
    }
  }
  if (filters.readyToSettle) {
    clauses.push(eq(bets.outcome, "pending"));
    clauses.push(
      sql`${bets.eventStartTime} <= NOW() - INTERVAL '2 hours 15 minutes'`,
    );
  }
  if (filters.needsReview) {
    clauses.push(eq(bets.outcome, "pending"));
    clauses.push(sql`${bets.settleAttempts} > 0`);
  }
  if (filters.placedOnly) {
    clauses.push(sql`${bets.placedAt} IS NOT NULL`);
  }
  if (filters.minEv !== undefined) {
    clauses.push(sql`${evExpr} >= ${filters.minEv}`);
  }
  if (filters.maxEv !== undefined) {
    clauses.push(sql`${evExpr} <= ${filters.maxEv}`);
  }
  if (filters.search) {
    const q = `%${filters.search}%`;
    clauses.push(
      sql`(${bets.homeTeam} ILIKE ${q} OR ${bets.awayTeam} ILIKE ${q} OR COALESCE(${bets.competition}, '') ILIKE ${q})`,
    );
  }
  if (filters.preMatchOnly) {
    clauses.push(sql`${bets.firstSeenAt} < ${bets.eventStartTime}`);
  }
  if (filters.oddsMin !== undefined) {
    clauses.push(sql`${bets.softOdds} >= ${filters.oddsMin}`);
  }
  if (filters.oddsMax !== undefined) {
    clauses.push(sql`${bets.softOdds} <= ${filters.oddsMax}`);
  }
  return clauses;
};

export const listBets = async (
  filters: ListFilters = {},
): Promise<{ rows: BetRow[]; total: number }> => {
  const clauses = buildFilterClauses(filters);
  const where = clauses.length ? and(...clauses) : undefined;

  const rows = await db
    .select()
    .from(bets)
    .where(where)
    .orderBy(desc(bets.firstSeenAt))
    .limit(filters.limit ?? 200)
    .offset(filters.offset ?? 0);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bets)
    .where(where);

  return { rows, total: count ?? 0 };
};

// ─── Aggregate (ROI / win-loss summary over the full filtered set) ────────────

export type BetsAggregate = {
  matched: number;
  settled: number;
  pending: number;
  placed: number;
  placedSettled: number;
  placedPending: number;
  wins: number;
  halfWins: number;
  losses: number;
  halfLosses: number;
  voids: number;
  /** 1-unit flat stake across all settled rows, commission-adjusted. */
  flat: {
    stake: number;
    pnl: number;
    roiPct: number;
    winRatePct: number;
  };
  /** Real money — only placed rows, uses actual stake/odds/pnl columns. */
  real: {
    stake: number;
    pnl: number;
    roiPct: number;
    winRatePct: number;
    openStake: number;
  };
};

/**
 * Aggregate counts + ROI across every row that matches `filters`, not just the
 * paginated slice. Mirrors `listBets` predicate-for-predicate.
 *
 * Flat ROI simulates the user's configured Kelly strategy (bankroll = 1 unit,
 * `kellyFraction` multiplier, `kellyCapPct` cap) on every settled bet. Changing
 * the strategy in the dashboard reshapes this denominator: high-edge bets get
 * proportionally more simulated stake under larger kellyFraction values, so
 * the ratio answers "what ROI would my strategy have produced on every
 * detected bet?". Real ROI uses the `pnl` column populated at placement-
 * settlement time — actual money only.
 */
export const aggregateBets = async (
  filters: ListFilters = {},
): Promise<BetsAggregate> => {
  const clauses = buildFilterClauses(filters);
  const where = clauses.length ? and(...clauses) : undefined;

  const { row: settings } = await getBettingSettings();
  const kellyFractionParam = Math.max(
    0,
    Math.min(1, settings.kellyFraction ?? 0.25),
  );
  // Cap expressed as a fraction of the synthetic 1-unit bankroll.
  const kellyCapParam = Math.max(0, (settings.kellyCapPct ?? 10) / 100);

  // Commission-adjusted net edge per unit staked (b in Kelly notation).
  const bExpr = sql`((${bets.softOdds} - 1) * (1 - COALESCE(${bets.softCommissionPct}, 0) / 100))`;
  // Full Kelly fraction derived on the fly from the stored sharp true-prob +
  // soft odds. Returns 0 when b ≤ 0 (no edge or soft book below fair price)
  // or when kelly would be negative.
  const fullKellyExpr = sql`
    CASE WHEN ${bExpr} > 0
      THEN GREATEST(
        0,
        (${bExpr} * ${bets.sharpTrueProb} - (1 - ${bets.sharpTrueProb})) / ${bExpr}
      )
      ELSE 0
    END
  `;
  // Simulated stake per row: fractional Kelly × bankroll (= 1), capped by
  // kellyCapPct (also a fraction of bankroll).
  const simStakeExpr = sql`LEAST(${fullKellyExpr} * ${kellyFractionParam}, ${kellyCapParam})`;
  // Commission-adjusted P&L per row, scaled by simulated stake.
  const flatPnlExpr = sql`
    ${simStakeExpr} *
    CASE ${bets.outcome}
      WHEN 'won'       THEN ${bExpr}
      WHEN 'half_won'  THEN ${bExpr} * 0.5
      WHEN 'lost'      THEN -1
      WHEN 'half_lost' THEN -0.5
      ELSE 0
    END
  `;
  const stakeWeightExpr = sql`
    ${simStakeExpr} *
    CASE ${bets.outcome}
      WHEN 'won'       THEN 1
      WHEN 'lost'      THEN 1
      WHEN 'half_won'  THEN 0.5
      WHEN 'half_lost' THEN 0.5
      ELSE 0
    END
  `;

  const isPlaced = sql`${bets.placedAt} IS NOT NULL`;
  const isSettled = sql`${bets.outcome} <> 'pending'`;

  const [row] = await db
    .select({
      matched: sql<number>`COUNT(*)::int`,
      settled: sql<number>`COUNT(*) FILTER (WHERE ${isSettled})::int`,
      pending: sql<number>`COUNT(*) FILTER (WHERE ${bets.outcome} = 'pending')::int`,
      placed: sql<number>`COUNT(*) FILTER (WHERE ${isPlaced})::int`,
      placedSettled: sql<number>`COUNT(*) FILTER (WHERE ${isPlaced} AND ${isSettled})::int`,
      placedPending: sql<number>`COUNT(*) FILTER (WHERE ${isPlaced} AND ${bets.outcome} = 'pending')::int`,
      wins: sql<number>`COUNT(*) FILTER (WHERE ${bets.outcome} = 'won')::int`,
      halfWins: sql<number>`COUNT(*) FILTER (WHERE ${bets.outcome} = 'half_won')::int`,
      losses: sql<number>`COUNT(*) FILTER (WHERE ${bets.outcome} = 'lost')::int`,
      halfLosses: sql<number>`COUNT(*) FILTER (WHERE ${bets.outcome} = 'half_lost')::int`,
      voids: sql<number>`COUNT(*) FILTER (WHERE ${bets.outcome} = 'void')::int`,
      flatPnl: sql<string>`COALESCE(SUM(${flatPnlExpr}) FILTER (WHERE ${isSettled}), 0)`,
      flatStake: sql<string>`COALESCE(SUM(${stakeWeightExpr}) FILTER (WHERE ${isSettled}), 0)`,
      realStake: sql<string>`COALESCE(SUM(${bets.stake}) FILTER (WHERE ${isPlaced} AND ${isSettled}), 0)`,
      realPnl: sql<string>`COALESCE(SUM(${bets.pnl}) FILTER (WHERE ${isPlaced} AND ${isSettled}), 0)`,
      realWins: sql<number>`COUNT(*) FILTER (WHERE ${isPlaced} AND ${bets.outcome} IN ('won','half_won'))::int`,
      realOpenStake: sql<string>`COALESCE(SUM(${bets.stake}) FILTER (WHERE ${isPlaced} AND ${bets.outcome} = 'pending'), 0)`,
    })
    .from(bets)
    .where(where);

  const num = (v: unknown): number => {
    if (v === null || v === undefined) return 0;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const matched = num(row?.matched);
  const settled = num(row?.settled);
  const pending = num(row?.pending);
  const placed = num(row?.placed);
  const placedSettled = num(row?.placedSettled);
  const placedPending = num(row?.placedPending);
  const wins = num(row?.wins);
  const halfWins = num(row?.halfWins);
  const losses = num(row?.losses);
  const halfLosses = num(row?.halfLosses);
  const voids = num(row?.voids);

  const flatPnl = num(row?.flatPnl);
  const flatStake = num(row?.flatStake);
  const realStake = num(row?.realStake);
  const realPnl = num(row?.realPnl);
  const realOpenStake = num(row?.realOpenStake);
  const realWins = num(row?.realWins);

  const winWeighted = wins + halfWins * 0.5;
  // Settled-count-denominated win rate matches the old client behaviour.
  const flatWinRate = settled > 0 ? (winWeighted / settled) * 100 : 0;
  // Textbook ROI over the simulated strategy: SUM(pnl) / SUM(stake). High-edge
  // bets get proportionally more simulated stake under larger kellyFraction,
  // so this reshapes with the user's strategy choice — not a 1-unit flat.
  const flatRoiPct = flatStake > 0 ? (flatPnl / flatStake) * 100 : 0;
  // Real ROI uses the realized stake total, which is what the user actually
  // put at risk — not a synthetic 1-unit basis.
  const realWinRate = placedSettled > 0 ? (realWins / placedSettled) * 100 : 0;

  return {
    matched,
    settled,
    pending,
    placed,
    placedSettled,
    placedPending,
    wins,
    halfWins,
    losses,
    halfLosses,
    voids,
    flat: {
      stake: flatStake,
      pnl: flatPnl,
      roiPct: flatRoiPct,
      winRatePct: flatWinRate,
    },
    real: {
      stake: realStake,
      pnl: realPnl,
      roiPct: realStake > 0 ? (realPnl / realStake) * 100 : 0,
      winRatePct: realWinRate,
      openStake: realOpenStake,
    },
  };
};

export const getBetById = async (id: string): Promise<BetRow | null> => {
  const rows = await db.select().from(bets).where(eq(bets.id, id)).limit(1);
  return rows[0] ?? null;
};

export const getBetsByIds = async (ids: string[]): Promise<BetRow[]> => {
  if (ids.length === 0) return [];
  return db.select().from(bets).where(inArray(bets.id, ids));
};

// ─── Outcome / settlement ─────────────────────────────────────────────────────

/**
 * Mark the outcome for a single bet.
 */
export const markOutcome = async (
  id: string,
  outcome: Outcome,
  source: string | null = null,
): Promise<BetRow | null> => {
  const normalized = normalizeOutcome(outcome);
  const now = new Date().toISOString();
  const rows = await db
    .update(bets)
    .set({
      outcome: normalized,
      outcomeMarkedAt: normalized === "pending" ? null : now,
      settledBySource: normalized === "pending" ? null : source,
      updatedAt: now,
    })
    .where(eq(bets.id, id))
    .returning();
  return rows[0] ?? null;
};

/**
 * Bulk outcome updater for rows that only need the outcome fields marked.
 * Placed-bet settlement side effects live in applySettlement().
 */
export const markOutcomesBulk = async (
  updates: { id: string; outcome: Outcome; source?: string | null }[],
): Promise<number> => {
  if (updates.length === 0) return 0;

  const normalized = updates.map((u) => ({
    id: u.id,
    outcome: normalizeOutcome(u.outcome),
    source: u.source ?? null,
  }));

  const tuples = sql.join(
    normalized.map((u) => sql`(${u.id}, ${u.outcome}, ${u.source}::text)`),
    sql`, `,
  );

  const result = await db.execute(sql`
    UPDATE ${bets}
       SET outcome           = v.outcome,
           outcome_marked_at = CASE WHEN v.outcome = 'pending' THEN NULL ELSE NOW() END,
           settled_by_source = CASE WHEN v.outcome = 'pending' THEN NULL ELSE v.source END,
           updated_at        = NOW()
       FROM (VALUES ${tuples}) AS v(id, outcome, source)
      WHERE ${bets.id} = v.id
  `);

  const rowCount =
    (result as unknown as { rowCount?: number }).rowCount ??
    (Array.isArray(result) ? result.length : 0);

  // Note: placed-bet side effects (settledAt, pnl, notifications) are
  // handled by applySettlement() and higher-level settlement helpers.

  return rowCount;
};

/**
 * Bump settle_attempts for bets the pipeline just processed.
 */
export const recordSettleAttempts = async (ids: string[]): Promise<void> => {
  if (ids.length === 0) return;
  await db
    .update(bets)
    .set({
      settleAttempts: sql`${bets.settleAttempts} + 1`,
      lastSettleAttemptAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
    })
    .where(inArray(bets.id, ids));
};

// ─── Placed bets queries ──────────────────────────────────────────────────────

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
  eventId: string;
  familyId: string;
  atomId: string;
  atomLabel: string;
  homeTeam: string;
  awayTeam: string;
  competition: string | null;
  eventStartTime: string;
  marketType: string;
  timeScope: string;
  familyLine: number | null;
  sharpProvider: string;
  sharpOdds: number;
  sharpTrueProb: number;
  sharpOddsAgeMs: number | null;
  softProvider: string;
  softCommissionPct: number;
  softOdds: number;
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
 * Sentinel thrown when the dedup index rejects an insert.
 */
export class DuplicatePlacedBetError extends Error {
  constructor(
    readonly eventId: string,
    readonly familyId: string,
    readonly atomId: string,
  ) {
    super(`Bet already placed for (${eventId}, ${familyId}, ${atomId})`);
    this.name = "DuplicatePlacedBetError";
  }
}

/**
 * Patch real placement fields (ticket id, booked stake/odds, request /
 * response payloads) onto a row that has already been reserved by
 * `reservePlacement`. Throws `DuplicatePlacedBetError` if the row was
 * never reserved (placed_at IS NULL) — that's a misuse of the API and
 * the caller should investigate, not retry.
 *
 * Deliberately does NOT touch `placedAt`. The reservation's timestamp
 * is authoritative; overwriting it on a racing second call was the
 * exact clobbering bug that let duplicate bets through before.
 */
export async function insertPlacedBet(
  input: NewPlacedBetInput,
): Promise<BetRow> {
  const now = new Date().toISOString();

  // Dedup invariant: bet id MUST be `${eventId}|${familyId}|${atomId}`.
  // Coerce even if the caller passed something else.
  const deterministicId = `${input.eventId}|${input.familyId}|${input.atomId}`;
  if (input.id !== deterministicId) {
    logger.warn(
      "BetPersist",
      `Non-deterministic id ${input.id} — coercing to ${deterministicId}`,
    );
    input = { ...input, id: deterministicId };
  }

  const rows = await db
    .update(bets)
    .set({
      provider: input.provider,
      stake: input.stake,
      odds: input.odds,
      currency: input.currency,
      providerTicketId: input.providerTicketId,
      mode: input.mode,
      requestPayload: input.requestPayload as never,
      responsePayload: input.responsePayload as never,
      updatedAt: now,
    })
    .where(and(eq(bets.id, input.id), sql`${bets.placedAt} IS NOT NULL`))
    .returning();

  if (rows.length === 0) {
    // Either the row doesn't exist, or it exists but is not reserved.
    // Both are programmer errors — every insertPlacedBet call should
    // be preceded by reservePlacement in the same logical flow.
    throw new DuplicatePlacedBetError(
      input.eventId,
      input.familyId,
      input.atomId,
    );
  }
  return rows[0]!;
}

/**
 * True iff a bet is already placed (non-cancelled) for this selection.
 * Used by the placer to check before submitting.
 */
export async function isAlreadyPlaced(
  eventId: string,
  familyId: string,
  atomId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: bets.id })
    .from(bets)
    .where(
      and(
        eq(bets.eventId, eventId),
        eq(bets.familyId, familyId),
        eq(bets.atomId, atomId),
        sql`${bets.outcome} <> 'cancelled'`,
        sql`${bets.placedAt} IS NOT NULL`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export interface ReservePlacementShell {
  atomLabel: string;
  homeTeam: string;
  awayTeam: string;
  competition: string | null;
  eventStartTime: string;
  marketType: string;
  timeScope: string;
  familyLine: number | null;
  sharpProvider: string;
  sharpOdds: number;
  sharpTrueProb: number;
  softProvider: string;
  softCommissionPct: number;
  softOdds: number;
}

/**
 * Atomically reserve a placement slot for a selection BEFORE submitting
 * to the book.
 *
 * One statement, two outcomes:
 *   - INSERT branch: row didn't exist yet (value detector hadn't persisted
 *     it). Row is created with placed_at=NOW(), stake=0, odds=1
 *     (sentinels — finaliseConfirmed / insertPlacedBet patches them in).
 *   - ON CONFLICT DO UPDATE branch: row exists. If placed_at IS NULL, we
 *     flip it to now and return the id. If placed_at IS NOT NULL, the
 *     partial `WHERE` clause blocks the update and RETURNING is empty —
 *     someone else already reserved/placed this selection.
 *
 * This replaces the racy `isAlreadyPlaced` SELECT-then-INSERT pattern.
 * Because the deterministic PK pins exactly one row per selection and
 * the partial `WHERE` clause is evaluated atomically with the UPDATE,
 * no two concurrent callers can both reserve the same slot — even
 * across sync cycles, process restarts, or HMR.
 */
export async function reservePlacement(args: {
  eventId: string;
  familyId: string;
  atomId: string;
  provider: string;
  mode: "auto" | "manual";
  currency: string;
  shell: ReservePlacementShell;
}): Promise<{ reserved: true; id: string } | { reserved: false }> {
  const id = `${args.eventId}|${args.familyId}|${args.atomId}`;
  const now = new Date().toISOString();
  const rows = await db
    .insert(bets)
    .values({
      id,
      eventId: args.eventId,
      familyId: args.familyId,
      atomId: args.atomId,
      atomLabel: args.shell.atomLabel,
      homeTeam: args.shell.homeTeam,
      awayTeam: args.shell.awayTeam,
      competition: args.shell.competition,
      eventStartTime: args.shell.eventStartTime,
      marketType: args.shell.marketType,
      timeScope: args.shell.timeScope,
      familyLine: args.shell.familyLine,
      sharpProvider: args.shell.sharpProvider,
      sharpOdds: args.shell.sharpOdds,
      sharpTrueProb: args.shell.sharpTrueProb,
      sharpOddsAgeMs: null,
      softProvider: args.shell.softProvider,
      softCommissionPct: args.shell.softCommissionPct,
      softOdds: args.shell.softOdds,
      provider: args.provider,
      mode: args.mode,
      currency: args.currency,
      // Sentinels — real values patched in by finaliseConfirmed /
      // insertPlacedBet after the book confirms.
      stake: 0,
      odds: 1,
      placedAt: now,
      outcome: "pending",
      firstSeenAt: now,
      lastSeenAt: now,
      tickCount: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: bets.id,
      set: {
        placedAt: sql`NOW()`,
        provider: args.provider,
        mode: args.mode,
        currency: args.currency,
        updatedAt: sql`NOW()`,
      },
      // Only reserve if the existing row hasn't been placed yet, OR if
      // a prior placement was cancelled (matches the legacy
      // isAlreadyPlaced exemption so cancelled selections can be
      // re-placed when a fresh value opportunity appears).
      setWhere: sql`${bets.placedAt} IS NULL OR ${bets.outcome} = 'cancelled'`,
    })
    .returning({ id: bets.id });
  if (rows.length === 0) return { reserved: false };
  return { reserved: true, id: rows[0]!.id };
}

/**
 * Roll back a prior `reservePlacement` call. Used when the adapter
 * threw or the book returned a transport-level error — the slot
 * should be released so the next valid tick can retry.
 *
 * We null out `placed_at`, `provider`, `mode`, `stake`, `odds` so the
 * row returns to its value-detector-shell state.
 */
export async function releaseReservation(id: string): Promise<void> {
  await db
    .update(bets)
    .set({
      placedAt: null,
      provider: null,
      mode: null,
      stake: null,
      odds: null,
      providerTicketId: null,
      requestPayload: null,
      responsePayload: null,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(bets.id, id), sql`${bets.providerTicketId} IS NULL`));
}

/** Fetch a single placed bet by id. */
export async function getPlacedBetById(id: string): Promise<BetRow | null> {
  return getBetById(id);
}

/** Newest-first list of placed bets, capped. */
export async function listPlacedBets(limit = 200): Promise<BetRow[]> {
  return db
    .select()
    .from(bets)
    .where(sql`${bets.placedAt} IS NOT NULL`)
    .orderBy(desc(bets.placedAt))
    .limit(limit);
}

/**
 * All currently-pending placed bets for a provider.
 */
export async function listPendingBetsForProvider(
  provider: string,
  limit = 500,
): Promise<BetRow[]> {
  return db
    .select()
    .from(bets)
    .where(
      and(
        eq(bets.provider, provider),
        eq(bets.outcome, "pending"),
        sql`${bets.placedAt} IS NOT NULL`,
      ),
    )
    .orderBy(desc(bets.placedAt))
    .limit(limit);
}

/**
 * Attach a book-assigned ticket id to a pending placed bet.
 */
export async function attachTicketId(
  betId: string,
  ticketId: string,
): Promise<BetRow | null> {
  const [updated] = await db
    .update(bets)
    .set({
      providerTicketId: ticketId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(bets.id, betId))
    .returning();
  return updated ?? null;
}

/**
 * Delete a bet row by id. Used by the reconciler when a pending placement
 * aged out without confirmation — allows retry via dedup.
 */
export async function deleteBet(betId: string): Promise<boolean> {
  const deleted = await db
    .delete(bets)
    .where(eq(bets.id, betId))
    .returning({ id: bets.id });
  return deleted.length > 0;
}

/**
 * Update closing odds and compute CLV for a placed bet.
 * Called by closing-capture.ts when the event starts.
 */
export async function recordClosingOdds(args: {
  betId: string;
  closingSoftOdds: number;
  closingSharpOdds: number;
}): Promise<BetRow | null> {
  const current = await getBetById(args.betId);
  if (!current) return null;

  const clvPct =
    current.odds && args.closingSoftOdds
      ? Number(
          ((Number(current.odds) / args.closingSoftOdds - 1) * 100).toFixed(2),
        )
      : null;

  const [updated] = await db
    .update(bets)
    .set({
      closingSoftOdds: args.closingSoftOdds,
      closingSharpOdds: args.closingSharpOdds,
      clvPct: clvPct !== null ? Number(clvPct) : null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(bets.id, args.betId))
    .returning();
  return updated ?? null;
}

/**
 * Apply settlement outcome and compute P&L.
 * Replaces the former cascadePlacedBetSettlements.
 */
export async function applySettlement(args: {
  betId: string;
  outcome: Exclude<PlacedBetStatus, "pending" | "cancelled">;
  settledBySource: string | null;
}): Promise<BetRow | null> {
  const current = await getBetById(args.betId);
  if (!current || current.outcome === args.outcome) return null;

  const pnl =
    current.stake && current.odds
      ? computePnl(Number(current.stake), Number(current.odds), args.outcome)
      : null;

  const [updated] = await db
    .update(bets)
    .set({
      outcome: args.outcome,
      settledAt: new Date().toISOString(),
      settledBySource: args.settledBySource,
      pnl: pnl !== null ? Number(pnl.toFixed(2)) : null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(bets.id, args.betId))
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
