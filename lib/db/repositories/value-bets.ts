import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../client";
import { valueBets, type ValueBetRow } from "../schema";
import type { ValueBet } from "@/lib/atoms/value-detector";
import { getEvent } from "@/lib/store";
import { getFamily } from "@/lib/atoms/registry";
import { logger } from "@/lib/shared/logger";
import { normalizeOutcome, type Outcome } from "@/lib/backtest/types";
import { formatAtomLabel } from "@/lib/formatting/labels";

/**
 * Collapse legacy "push" outcome to "void" on read — our atom settlement
 * treats them identically (stake returned). Keeps legacy rows working
 * until the migration is run, and is a harmless no-op after.
 */
const coerceOutcome = <T extends { outcome: string }>(row: T): T =>
  row.outcome === "push" ? { ...row, outcome: "void" } : row;
const coerceRows = <T extends { outcome: string }>(rows: T[]): T[] =>
  rows.map(coerceOutcome);

export type PersistResult = {
  attempted: number;
  inserted: number;
  updated: number;
  skippedNoEvent: number;
  skippedNoFamily: number;
  errors: number;
};

const toIso = (d: Date | string | number): string =>
  typeof d === "string" ? d : new Date(d).toISOString();

const normalizeConfidence = (raw: number | undefined | null): number | null => {
  if (raw == null) return null;
  if (raw > 1) return Number((raw / 100).toFixed(3));
  return Number(raw.toFixed(3));
};

export const persistValueBets = async (
  bets: ValueBet[],
): Promise<PersistResult> => {
  const result: PersistResult = {
    attempted: bets.length,
    inserted: 0,
    updated: 0,
    skippedNoEvent: 0,
    skippedNoFamily: 0,
    errors: 0,
  };

  for (const vb of bets) {
    const event = getEvent(vb.eventId);
    if (!event) {
      result.skippedNoEvent++;
      logger.warn(
        "ValueBetPersist",
        `Skip ${vb.id}: event ${vb.eventId} not in store`,
      );
      continue;
    }
    const family = getFamily(vb.familyId);
    if (!family) {
      result.skippedNoFamily++;
      logger.warn(
        "ValueBetPersist",
        `Skip ${vb.id}: family ${vb.familyId} not in registry`,
      );
      continue;
    }

    const detectedIso = toIso(vb.detectedAt ?? new Date());
    const stableId = `${vb.eventId}|${vb.familyId}|${vb.atomId}`;
    const payload = {
      id: stableId,
      eventId: vb.eventId,
      familyId: vb.familyId,
      atomId: vb.atomId,
      atomLabel: formatAtomLabel(vb.atomId),
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      competition: event.competition ?? null,
      eventStartTime: toIso(event.startTime),
      matchConfidence: normalizeConfidence(event.matchConfidence),
      marketType: family.market_type,
      timeScope: family.time_scope,
      familyLine: family.line ?? null,
      sharpProvider: vb.sharpProvider,
      sharpOdds: vb.sharpOdds,
      sharpTrueProb: vb.trueProb,
      sharpOddsAgeMs: vb.sharpOddsAgeMs,
      softProvider: vb.softProvider,
      softCommissionPct: vb.commissionPct,
      softOddsFirst: vb.softOdds,
      softOddsLast: vb.softOdds,
      softOddsMax: vb.softOdds,
      firstSeenAt: detectedIso,
      lastSeenAt: detectedIso,
      tickCount: 1,
    };

    try {
      const rows = await db
        .insert(valueBets)
        .values(payload)
        .onConflictDoUpdate({
          target: valueBets.id,
          set: {
            lastSeenAt: detectedIso,
            softOddsLast: vb.softOdds,
            softOddsMax: sql`GREATEST(${valueBets.softOddsMax}, ${vb.softOdds})`,
            // When a different provider offers a better price on the same
            // outcome, re-attribute the row to that provider. We only bet the
            // best price, so the row should describe the book we'd actually use.
            softProvider: sql`CASE WHEN ${vb.softOdds} > ${valueBets.softOddsMax} THEN ${vb.softProvider} ELSE ${valueBets.softProvider} END`,
            softCommissionPct: sql`CASE WHEN ${vb.softOdds} > ${valueBets.softOddsMax} THEN ${vb.commissionPct} ELSE ${valueBets.softCommissionPct} END`,
            // Sharp side must track the current Pinnacle read — the auto-placer
            // re-derives EV from the row, so a stale trueProb paired with a
            // fresh softOddsLast produces a bogus edge and places on decayed
            // prices. Freshness is gated downstream by the placer's EV floor.
            sharpOdds: vb.sharpOdds,
            sharpTrueProb: vb.trueProb,
            sharpOddsAgeMs: vb.sharpOddsAgeMs,
            tickCount: sql`${valueBets.tickCount} + 1`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ tick: valueBets.tickCount });
      if (rows[0]?.tick === 1) result.inserted++;
      else result.updated++;

      // Fire the auto-placer on every persistence tick, not just the
      // first. A bet that was skipped on tick 1 (auto-place toggle off,
      // cold market-refs cache, balance not yet fetched, etc.) must get
      // re-evaluated on later ticks, otherwise flipping the toggle on
      // mid-detection strands the bet forever. Duplicate-placement is
      // prevented by three independent guards inside the placer:
      // isAlreadyPlaced (DB UNIQUE index on event/family/atom), the
      // in-flight promise map, and the 9W pending-confirmation tracker.
      // Imported lazily to avoid a circular dep (placer →
      // repos/placed-bets → repos/value-bets). Failures are logged but
      // don't block the detection pipeline — auto-placement is
      // best-effort.
      try {
        const { maybeAutoPlace } = await import("@/lib/betting/auto-placer");
        await maybeAutoPlace(vb);
      } catch (err) {
        logger.error(
          "ValueBetPersist",
          `auto-place hook failed for ${stableId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
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
        "ValueBetPersist",
        `Upsert failed for ${stableId}: ${e.message}${meta ? ` | ${meta}` : ""}`,
      );
    }
  }

  return result;
};

export type ListFilters = {
  from?: string;
  to?: string;
  marketTypes?: string[];
  softProviders?: string[];
  outcome?: Outcome | "settled" | "unsettled";
  /**
   * Filter already-settled bets by the pipeline tier/source that
   * produced the outcome (e.g. "sofascore", "espn", "manual"). Empty
   * or omitted = no restriction.
   */
  settledBySources?: string[];
  minEv?: number;
  maxEv?: number;
  search?: string;
  readyToSettle?: boolean;
  /**
   * Bets the pipeline tried to settle but couldn't
   * (`outcome='pending' AND settle_attempts > 0`). Backed by a partial
   * index. Use this for a "needs human review" tab.
   */
  needsReview?: boolean;
  /**
   * When true, exclude historical in-play pollution — rows where the bet was
   * first detected at or after kickoff. Platform is pre-match only (see
   * `in-play.md`); any such rows are pre-2026-04-19 artefacts and should not
   * be surfaced in analytics.
   */
  preMatchOnly?: boolean;
  limit?: number;
  offset?: number;
};

// SQL expression for EV% computed at ENTRY PRICE (soft_odds_first). This
// is the EV the user would have actually realised by placing at detection.
// Kept in sync with derive.evPctFirst — if the formula changes there, mirror
// it here so minEv/maxEv filters stay consistent across DB and client code.
const evFirstExpr = sql`((1 + (${valueBets.softOddsFirst} - 1) * (1 - ${valueBets.softCommissionPct} / 100)) * ${valueBets.sharpTrueProb} - 1) * 100`;

export const listValueBets = async (
  filters: ListFilters = {},
): Promise<{ rows: ValueBetRow[]; total: number }> => {
  const clauses = [];
  if (filters.from) clauses.push(gte(valueBets.firstSeenAt, filters.from));
  if (filters.to) clauses.push(lte(valueBets.firstSeenAt, filters.to));
  if (filters.marketTypes && filters.marketTypes.length > 0) {
    clauses.push(inArray(valueBets.marketType, filters.marketTypes));
  }
  if (filters.softProviders && filters.softProviders.length > 0) {
    clauses.push(inArray(valueBets.softProvider, filters.softProviders));
  }
  if (filters.settledBySources && filters.settledBySources.length > 0) {
    clauses.push(inArray(valueBets.settledBySource, filters.settledBySources));
  }
  if (filters.outcome) {
    if (filters.outcome === "settled") {
      clauses.push(sql`${valueBets.outcome} <> 'pending'`);
    } else if (filters.outcome === "unsettled") {
      clauses.push(eq(valueBets.outcome, "pending"));
    } else {
      clauses.push(eq(valueBets.outcome, filters.outcome));
    }
  }
  if (filters.readyToSettle) {
    clauses.push(eq(valueBets.outcome, "pending"));
    clauses.push(
      sql`${valueBets.eventStartTime} <= NOW() - INTERVAL '2 hours 15 minutes'`,
    );
  }
  if (filters.needsReview) {
    // Pipeline tried + no tier could resolve — the human-review bucket.
    // Backed by the partial index `value_bets_needs_review_idx`.
    clauses.push(eq(valueBets.outcome, "pending"));
    clauses.push(sql`${valueBets.settleAttempts} > 0`);
  }
  if (filters.minEv !== undefined) {
    clauses.push(sql`${evFirstExpr} >= ${filters.minEv}`);
  }
  if (filters.maxEv !== undefined) {
    clauses.push(sql`${evFirstExpr} <= ${filters.maxEv}`);
  }
  if (filters.search) {
    const q = `%${filters.search}%`;
    clauses.push(
      sql`(${valueBets.homeTeam} ILIKE ${q} OR ${valueBets.awayTeam} ILIKE ${q} OR COALESCE(${valueBets.competition}, '') ILIKE ${q})`,
    );
  }
  if (filters.preMatchOnly) {
    clauses.push(sql`${valueBets.firstSeenAt} < ${valueBets.eventStartTime}`);
  }
  const where = clauses.length ? and(...clauses) : undefined;

  const rows = await db
    .select()
    .from(valueBets)
    .where(where)
    .orderBy(desc(valueBets.firstSeenAt))
    .limit(filters.limit ?? 200)
    .offset(filters.offset ?? 0);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(valueBets)
    .where(where);

  return { rows: coerceRows(rows), total: count ?? 0 };
};

export const getValueBetById = async (
  id: string,
): Promise<ValueBetRow | null> => {
  const rows = await db
    .select()
    .from(valueBets)
    .where(eq(valueBets.id, id))
    .limit(1);
  return rows[0] ? coerceOutcome(rows[0]) : null;
};

export const getValueBetsByIds = async (
  ids: string[],
): Promise<ValueBetRow[]> => {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(valueBets)
    .where(inArray(valueBets.id, ids));
  return coerceRows(rows);
};

export const markOutcome = async (
  id: string,
  outcome: Outcome,
  source: string | null = null,
): Promise<ValueBetRow | null> => {
  const normalized = normalizeOutcome(outcome);
  const now = new Date().toISOString();
  const rows = await db
    .update(valueBets)
    .set({
      outcome: normalized,
      outcomeMarkedAt: normalized === "pending" ? null : now,
      settledBySource: normalized === "pending" ? null : source,
      updatedAt: now,
    })
    .where(eq(valueBets.id, id))
    .returning();
  return rows[0] ? coerceOutcome(rows[0]) : null;
};

/**
 * Bulk outcome updater. Previously this was a per-row UPDATE loop — fine
 * at small volumes but a drag for the waterfall's batched settlement paths
 * that can apply 500+ outcomes in one shot. The query below folds the
 * entire batch into a single round-trip using an UPDATE ... FROM (VALUES ...)
 * join; Postgres plans it as one seq-or-index scan over the temp rows.
 *
 * `outcome_marked_at` is set to NOW() for terminal outcomes and cleared
 * for "pending". `settled_by_source` carries the pipeline tier/source
 * that produced the outcome (e.g. "sofascore", "espn", "url-context",
 * "manual") so the UI and audits can see durably which part of the
 * pipeline settled each bet.
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

  // Build VALUES (id, outcome, source), parameterized. sql.raw is avoided
  // — every dynamic value flows through sql`${…}` so there's no injection
  // surface. A NULL source on a terminal outcome is allowed (legacy rows
  // pre-dating this column, or rows the operator marked manually in bulk).
  const tuples = sql.join(
    normalized.map((u) => sql`(${u.id}, ${u.outcome}, ${u.source}::text)`),
    sql`, `,
  );

  const result = await db.execute(sql`
    UPDATE ${valueBets}
       SET outcome           = v.outcome,
           outcome_marked_at = CASE WHEN v.outcome = 'pending' THEN NULL ELSE NOW() END,
           settled_by_source = CASE WHEN v.outcome = 'pending' THEN NULL ELSE v.source END,
           updated_at        = NOW()
      FROM (VALUES ${tuples}) AS v(id, outcome, source)
     WHERE ${valueBets.id} = v.id
  `);

  // drizzle-orm on node-postgres returns either { rowCount } or an array —
  // normalize both shapes.
  const rowCount =
    (result as unknown as { rowCount?: number }).rowCount ??
    (Array.isArray(result) ? result.length : 0);

  // Cascade: any placed_bets tied to these value_bet ids inherit the
  // outcome, get P&L computed, CLV snapshotted, and fire a Telegram
  // settlement notification. Kept here (rather than in the settle
  // pipeline) so every caller of markOutcomesBulk — manual settle
  // endpoints, bulk admin tools, auto-settler — gets the cascade for
  // free. Imported lazily to avoid a repository → placer dependency
  // cycle and to keep the settlement pipeline reusable.
  try {
    const { cascadePlacedBetSettlements } =
      await import("@/lib/betting/settlement-cascade");
    await cascadePlacedBetSettlements(normalized);
  } catch (err) {
    logger.error(
      "ValueBetSettle",
      `placed-bet cascade failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return rowCount;
};

/**
 * Bump `settle_attempts` + stamp `last_settle_attempt_at` for every id
 * the scheduler just processed, regardless of whether it resolved.
 * Used by the auto-settler to mark rows that went through the pipeline
 * so the UI can surface the "Needs review" bucket (pending + attempts>0).
 */
export const recordSettleAttempts = async (ids: string[]): Promise<void> => {
  if (ids.length === 0) return;
  await db
    .update(valueBets)
    .set({
      settleAttempts: sql`${valueBets.settleAttempts} + 1`,
      lastSettleAttemptAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
    })
    .where(inArray(valueBets.id, ids));
};
