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
import { and, desc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../client";
import {
  bets,
  autoPlacerLog,
  matchScores,
  mlTrainingExamples,
  type BetRow,
} from "../schema";
import { getEvent } from "@/lib/store";
import { getFamily } from "@/lib/atoms/registry";
import { logger } from "@/lib/shared/logger";
import { normalizeOutcome, type Outcome } from "@/lib/bets-history/types";
import { formatAtomLabel } from "@/lib/formatting/labels";
import { getBettingSettings } from "./betting-settings";
import { recordPredictionBatch } from "./ml-prediction-audit";
import {
  FEATURE_COUNT,
  FEATURE_NAMES_HASH,
  FEATURE_VERSION,
} from "@/lib/ml/feature-contract";
import { adjustOddsForCommission } from "@/lib/shared/commission";
import {
  computeModelEdgePct,
  computeRawStakeMultiplier,
} from "@/lib/ml/staker";
import { classifyDecisionDriver } from "@/lib/ml/decision-reason";
import { getPermissionLevel } from "@/lib/ml/deployment-gate";

// ─── Type re-exports for backwards compatibility ────────────────────────────────

import type { BetMatchScore } from "@/lib/bets-history/types";

export type { BetRow as ValueBetRow };

/** BetRow augmented with the cached match score subset attached by listBets. */
export type BetRowWithScore = BetRow & { matchScore?: BetMatchScore | null };
export type PersistResult = {
  attempted: number;
  inserted: number;
  updated: number;
  skippedNoEvent: number;
  skippedNoFamily: number;
  errors: number;
  lastError: string | null;
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

const toIso = (d: Date | string | number): string =>
  typeof d === "string" ? d : new Date(d).toISOString();

function computeBaseline(row: BetRow): {
  evPct: number | null;
  kellyFraction: number | null;
} {
  const adjustedSoftOdds = adjustOddsForCommission(
    Number(row.softOdds),
    Number(row.softCommissionPct ?? 0),
  );
  const sharpTrueProb = Number(row.sharpTrueProb);
  if (
    !Number.isFinite(adjustedSoftOdds) ||
    adjustedSoftOdds <= 1 ||
    !Number.isFinite(sharpTrueProb)
  ) {
    return { evPct: null, kellyFraction: null };
  }

  const edge = adjustedSoftOdds * sharpTrueProb - 1;
  return {
    evPct: edge * 100,
    kellyFraction: edge > 0 ? Math.max(0, edge / (adjustedSoftOdds - 1)) : 0,
  };
}

async function mirrorPredictionAudit(row: BetRow): Promise<void> {
  const mlScore = row.mlScore == null ? null : Number(row.mlScore);
  const features = row.mlFeatures;
  if (!features || mlScore == null || !Number.isFinite(mlScore)) return;
  if (
    row.mlFeatureVersion == null ||
    row.mlFeatureCount == null ||
    !row.mlFeatureNamesHash
  ) {
    return;
  }

  const rawMultiplier = computeRawStakeMultiplier(mlScore, features);
  const modelEdgePct = computeModelEdgePct(mlScore, features);
  const decision = classifyDecisionDriver(
    mlScore,
    features,
    rawMultiplier,
  ).decision;
  const baseline = computeBaseline(row);
  const { getScorerStatus } = await import("@/lib/ml/scorer");

  await recordPredictionBatch([
    {
      scoredAt: row.lastSeenAt,
      betId: row.id,
      eventId: row.eventId,
      familyId: row.familyId,
      atomId: row.atomId,
      atomLabel: row.atomLabel,
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      competition: row.competition,
      eventStartTime: row.eventStartTime,
      marketType: row.marketType,
      timeScope: row.timeScope,
      familyLine: row.familyLine,
      softProvider: row.softProvider,
      softOdds: row.softOdds,
      softCommissionPct: row.softCommissionPct,
      sharpProvider: row.sharpProvider,
      sharpOdds: row.sharpOdds,
      sharpTrueProb: row.sharpTrueProb,
      baselineEvPct: baseline.evPct,
      baselineKellyFraction: baseline.kellyFraction,
      modelVersion: getScorerStatus().modelVersion,
      mlScore,
      modelEdgePct,
      kellyMultiplier: rawMultiplier,
      mlStakeFraction: row.mlStakeFraction,
      decision,
      permissionLevel: getPermissionLevel(),
      mlFeatures: features,
      mlFeatureVersion: row.mlFeatureVersion,
      mlFeatureCount: row.mlFeatureCount,
      mlFeatureNamesHash: row.mlFeatureNamesHash,
      outcome: row.outcome,
      pnl: row.pnl,
      clvPct: row.clvPct,
      settledAt: row.settledAt,
    },
  ]);
}

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

    softProvider: string;
    commissionPct: number;
    softOdds: number;
    detectedAt: Date | string | number;
    oddsMovement?: Record<
      string,
      import("@/lib/bets-history/types").OddsMovementData
    >;
    mlFeatures?: number[] | null;
    mlScore?: number | null;
    mlStakeFraction?: number | null;
  }>,
): Promise<PersistResult> => {
  const result: PersistResult = {
    attempted: betsToPersist.length,
    inserted: 0,
    updated: 0,
    skippedNoEvent: 0,
    skippedNoFamily: 0,
    errors: 0,
    lastError: null as string | null,
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

    const hasMlFeatures = Object.prototype.hasOwnProperty.call(
      vb,
      "mlFeatures",
    );
    const hasMlScore = Object.prototype.hasOwnProperty.call(vb, "mlScore");
    const hasMlStakeFraction = Object.prototype.hasOwnProperty.call(
      vb,
      "mlStakeFraction",
    );

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
      softProvider: vb.softProvider,
      softCommissionPct: vb.commissionPct,
      softOdds: vb.softOdds,
      firstSeenAt: toIso(vb.detectedAt),
      lastSeenAt: toIso(vb.detectedAt),
      tickCount: 1,
      oddsMovement: vb.oddsMovement ?? null,
      mlFeatures: vb.mlFeatures ?? null,
      mlFeatureVersion: vb.mlFeatures ? FEATURE_VERSION : null,
      mlFeatureCount: vb.mlFeatures ? FEATURE_COUNT : null,
      mlFeatureNamesHash: vb.mlFeatures ? FEATURE_NAMES_HASH : null,
      mlScore: vb.mlScore ?? null,
      mlStakeFraction: vb.mlStakeFraction ?? null,
      // Placement fields remain NULL for newly detected opportunities
      outcome: "pending" as const,
    };

    try {
      // "Best Soft Odds Wins" (see §7.2 of reactive-odds-engine-architecture.md)
      // Only update the soft side if the new effective payout beats the existing.
      //
      // Effective payout = 1 + (odds - 1) * (1 - commission/100)
      //
      // ⚠ IMPORTANT: each CASE WHEN inlines its own payout expression.
      // Do NOT extract into a shared `sql` variable — Drizzle duplicates
      // bound params on every embed, causing parameter-position drift
      // that makes Postgres misinterpret softOdds as an integer.
      const rows = await db
        .insert(bets)
        .values(payload)
        .onConflictDoUpdate({
          target: bets.id,
          set: {
            lastSeenAt: toIso(vb.detectedAt),
            // Sharp side — always update to current Pinnacle read
            sharpOdds: vb.sharpOdds,
            sharpTrueProb: vb.trueProb,
            // Soft side — only update if new effective payout > existing
            softProvider: sql`CASE WHEN (1 + (${vb.softOdds}::numeric - 1) * (1 - ${vb.commissionPct}::numeric / 100.0)) > (1 + (${bets.softOdds} - 1) * (1 - ${bets.softCommissionPct} / 100.0)) THEN ${vb.softProvider} ELSE ${bets.softProvider} END`,
            softCommissionPct: sql`CASE WHEN (1 + (${vb.softOdds}::numeric - 1) * (1 - ${vb.commissionPct}::numeric / 100.0)) > (1 + (${bets.softOdds} - 1) * (1 - ${bets.softCommissionPct} / 100.0)) THEN ${vb.commissionPct}::numeric ELSE ${bets.softCommissionPct} END`,
            softOdds: sql`CASE WHEN (1 + (${vb.softOdds}::numeric - 1) * (1 - ${vb.commissionPct}::numeric / 100.0)) > (1 + (${bets.softOdds} - 1) * (1 - ${bets.softCommissionPct} / 100.0)) THEN ${vb.softOdds}::numeric ELSE ${bets.softOdds} END`,
            // tick_count — only bump when the bet's own terms changed:
            //   1. Sharp odds differ from stored value, OR
            //   2. Soft side is being upgraded (new payout > existing)
            // This prevents inflated counts from sibling-atom dirty signals
            // within the same family.
            tickCount: sql`CASE WHEN ${bets.sharpOdds} IS DISTINCT FROM ${vb.sharpOdds}::numeric OR (1 + (${vb.softOdds}::numeric - 1) * (1 - ${vb.commissionPct}::numeric / 100.0)) > (1 + (${bets.softOdds} - 1) * (1 - ${bets.softCommissionPct} / 100.0)) THEN ${bets.tickCount} + 1 ELSE ${bets.tickCount} END`,
            // Update movement snapshot — preserve existing if new snapshot is null
            // (can happen when ring buffer hasn't accumulated data yet)
            oddsMovement: vb.oddsMovement
              ? vb.oddsMovement
              : sql`${bets.oddsMovement}`,
            // ML fields are explicit-state inputs: when the detector passes
            // null, clear stale model state instead of preserving an old score
            // from a previous warm/model-loaded pass.
            mlFeatures: hasMlFeatures
              ? (vb.mlFeatures ?? null)
              : sql`${bets.mlFeatures}`,
            mlFeatureVersion: hasMlFeatures
              ? vb.mlFeatures
                ? FEATURE_VERSION
                : null
              : sql`${bets.mlFeatureVersion}`,
            mlFeatureCount: hasMlFeatures
              ? vb.mlFeatures
                ? FEATURE_COUNT
                : null
              : sql`${bets.mlFeatureCount}`,
            mlFeatureNamesHash: hasMlFeatures
              ? vb.mlFeatures
                ? FEATURE_NAMES_HASH
                : null
              : sql`${bets.mlFeatureNamesHash}`,
            mlScore: hasMlScore ? (vb.mlScore ?? null) : sql`${bets.mlScore}`,
            mlStakeFraction: hasMlStakeFraction
              ? (vb.mlStakeFraction ?? null)
              : sql`${bets.mlStakeFraction}`,
          },
        })
        .returning();
      const row = rows[0];
      if (row?.tickCount === 1) result.inserted++;
      else result.updated++;

      if (row) {
        void mirrorPredictionAudit(row);
      }

      if (
        hasMlFeatures &&
        vb.mlFeatures &&
        row &&
        row.outcome !== "pending" &&
        row.outcome !== "void"
      ) {
        void import("@/lib/ml/training-example-writer")
          .then(({ writeSettledExamples }) => writeSettledExamples([row]))
          .catch((hookErr) => {
            logger.warn(
              "BetPersist",
              `Failed to reconcile settled ML example for ${row.id}: ${(hookErr as Error).message}`,
            );
          });
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
        "BetPersist",
        `Upsert failed for ${vb.id}: ${e.message}${meta ? ` | ${meta}` : ""}`,
      );
      result.lastError = `${e.message}${meta ? ` | ${meta}` : ""}`;
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
  /** True = placed rows only; false = detected-only rows. */
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
  /** Strategy `min_sharp_prob` — sharp true probability ≥ this value. */
  minSharpProb?: number;

  /** Strategy `min_tick_count` — bet has been refreshed ≥ this many times. */
  minTickCount?: number;
  /** Placement mode filter — 'auto' or 'manual'. */
  mode?: "auto" | "manual";
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
  if (filters.placedOnly === true) {
    clauses.push(sql`${bets.placedAt} IS NOT NULL`);
  } else if (filters.placedOnly === false) {
    clauses.push(sql`${bets.placedAt} IS NULL`);
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
  if (filters.minSharpProb !== undefined) {
    clauses.push(sql`${bets.sharpTrueProb} >= ${filters.minSharpProb}`);
  }

  if (filters.minTickCount !== undefined) {
    clauses.push(sql`${bets.tickCount} >= ${filters.minTickCount}`);
  }
  if (filters.mode) {
    clauses.push(eq(bets.mode, filters.mode));
  }
  return clauses;
};

export const listBets = async (
  filters: ListFilters = {},
): Promise<{ rows: BetRowWithScore[]; total: number }> => {
  const clauses = buildFilterClauses(filters);
  const where = clauses.length ? and(...clauses) : undefined;

  const baseRows = await db
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

  // Attach cached match scores so the UI can render the FT/HT/source breakdown
  // in the outcome-status tooltip without an extra round-trip per row. We
  // intentionally fetch only the columns the tooltip needs.
  const rows: BetRowWithScore[] = baseRows;
  const eventIds = Array.from(new Set(rows.map((r) => r.eventId)));
  if (eventIds.length > 0) {
    const scoreRows = await db
      .select({
        eventId: matchScores.eventId,
        status: matchScores.status,
        htHome: matchScores.htHome,
        htAway: matchScores.htAway,
        ftHome: matchScores.ftHome,
        ftAway: matchScores.ftAway,
        etHome: matchScores.etHome,
        etAway: matchScores.etAway,
        penHome: matchScores.penHome,
        penAway: matchScores.penAway,
        cornersHome: matchScores.cornersHome,
        cornersAway: matchScores.cornersAway,
        bookingsHome: matchScores.bookingsHome,
        bookingsAway: matchScores.bookingsAway,
        source: matchScores.source,
        confidence: matchScores.confidence,
      })
      .from(matchScores)
      .where(inArray(matchScores.eventId, eventIds));
    const scoreById = new Map(scoreRows.map((s) => [s.eventId, s]));
    for (const row of rows) {
      const s = scoreById.get(row.eventId);
      if (s) {
        row.matchScore = {
          status: s.status,
          htHome: s.htHome,
          htAway: s.htAway,
          ftHome: s.ftHome,
          ftAway: s.ftAway,
          etHome: s.etHome,
          etAway: s.etAway,
          penHome: s.penHome,
          penAway: s.penAway,
          cornersHome: s.cornersHome,
          cornersAway: s.cornersAway,
          bookingsHome: s.bookingsHome,
          bookingsAway: s.bookingsAway,
          source: s.source,
          confidence: Number(s.confidence),
        };
      }
    }
  }

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

export interface HistoricalBackfillBetRow {
  id: string;
  eventStartTime: string;
  firstSeenAt: string;
  competition: string | null;
  marketType: string;
  familyLine: number | null;
  sharpProvider: string;
  sharpOdds: number;
  sharpTrueProb: number;
  softProvider: string;
  softCommissionPct: number;
  softOdds: number;
  oddsMovement:
    | Record<string, import("@/lib/bets-history/types").OddsMovementData>
    | import("@/lib/bets-history/types").OddsMovementData
    | null;
  mlFeatures: number[] | null;
  mlFeatureVersion: number | null;
  mlFeatureCount: number | null;
  mlFeatureNamesHash: string | null;
}

export async function listHistoricalBackfillBets(args: {
  afterId?: string;
  limit: number;
}): Promise<HistoricalBackfillBetRow[]> {
  const clauses = [sql`${bets.outcome} NOT IN ('pending', 'void')`];
  if (args.afterId) {
    clauses.push(gt(bets.id, args.afterId));
  }

  return db
    .select({
      id: bets.id,
      eventStartTime: bets.eventStartTime,
      firstSeenAt: bets.firstSeenAt,
      competition: bets.competition,
      marketType: bets.marketType,
      familyLine: bets.familyLine,
      sharpProvider: bets.sharpProvider,
      sharpOdds: bets.sharpOdds,
      sharpTrueProb: bets.sharpTrueProb,
      softProvider: bets.softProvider,
      softCommissionPct: bets.softCommissionPct,
      softOdds: bets.softOdds,
      oddsMovement: bets.oddsMovement,
      mlFeatures: bets.mlFeatures,
      mlFeatureVersion: bets.mlFeatureVersion,
      mlFeatureCount: bets.mlFeatureCount,
      mlFeatureNamesHash: bets.mlFeatureNamesHash,
    })
    .from(bets)
    .where(and(...clauses))
    .orderBy(bets.id)
    .limit(args.limit);
}

export async function updateHistoricalMlFeatures(
  updates: Array<{
    id: string;
    features: number[];
    featureVersion: number;
    featureCount: number;
    featureNamesHash: string;
  }>,
): Promise<number> {
  if (updates.length === 0) return 0;

  const payload = JSON.stringify(
    updates.map((row) => ({
      id: row.id,
      features: row.features,
      feature_version: row.featureVersion,
      feature_count: row.featureCount,
      feature_names_hash: row.featureNamesHash,
    })),
  );

  const result = await db.execute(sql`
    WITH payload AS (
      SELECT *
      FROM jsonb_to_recordset(${payload}::jsonb) AS p(
        id text,
        features real[],
        feature_version integer,
        feature_count integer,
        feature_names_hash text
      )
    )
    UPDATE ${bets} b
    SET ml_features = payload.features,
        ml_feature_version = payload.feature_version,
        ml_feature_count = payload.feature_count,
        ml_feature_names_hash = payload.feature_names_hash
    FROM payload
    WHERE b.id = payload.id
    RETURNING b.id
  `);

  return result.rows.length;
}

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
      settledAt: normalized === "pending" ? null : now,
      settledBySource: normalized === "pending" ? null : source,
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
           settled_at        = CASE WHEN v.outcome = 'pending' THEN NULL ELSE NOW() END,
           settled_by_source = CASE WHEN v.outcome = 'pending' THEN NULL ELSE v.source END
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

  softProvider: string;
  softCommissionPct: number;
  softOdds: number;
  provider: string;
  stake: number;
  odds: number;
  currency: string;
  providerTicketId: string | null;
  mode: "auto" | "manual";
  placedMlScore?: number | null;
  placedMlModelEdgePct?: number | null;
  placedMlDecision?: string | null;
  placedMlKellyMultiplier?: number | null;
  placedMlModelVersion?: number | null;
  placedMlFeatures?: number[] | null;
  placedMlFeatureVersion?: number | null;
  placedMlFeatureCount?: number | null;
  placedMlFeatureNamesHash?: string | null;
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
      placedMlScore: input.placedMlScore ?? null,
      placedMlModelEdgePct: input.placedMlModelEdgePct ?? null,
      placedMlDecision: input.placedMlDecision ?? null,
      placedMlKellyMultiplier: input.placedMlKellyMultiplier ?? null,
      placedMlModelVersion: input.placedMlModelVersion ?? null,
      placedMlFeatures: input.placedMlFeatures ?? null,
      placedMlFeatureVersion: input.placedMlFeatureVersion ?? null,
      placedMlFeatureCount: input.placedMlFeatureCount ?? null,
      placedMlFeatureNamesHash: input.placedMlFeatureNamesHash ?? null,
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
    })
    .onConflictDoUpdate({
      target: bets.id,
      set: {
        placedAt: sql`NOW()`,
        provider: args.provider,
        mode: args.mode,
        currency: args.currency,
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
  const result = await db.transaction(async (tx) => {
    await tx.delete(autoPlacerLog).where(eq(autoPlacerLog.betId, betId));
    await tx
      .delete(mlTrainingExamples)
      .where(eq(mlTrainingExamples.sourceBetId, betId));
    const deleted = await tx
      .delete(bets)
      .where(eq(bets.id, betId))
      .returning({ id: bets.id });
    return deleted.length > 0;
  });
  return result;
}

/**
 * Update closing odds and compute CLV for a bet.
 * Called by closing-capture.ts when the event starts.
 *
 * CLV is computed for ALL bets:
 *   - Placed bets: (placedOdds / closingSharp - 1) * 100
 *   - Non-placed: (adjSoftOdds / closingSharp - 1) * 100
 */
export async function recordClosingOdds(args: {
  betId: string;
  closingSharpOdds: number;
}): Promise<BetRow | null> {
  const current = await getBetById(args.betId);
  if (!current) return null;

  let clvPct: number | null = null;
  if (args.closingSharpOdds > 0) {
    if (current.placedAt && current.odds) {
      // Placed bet: CLV against placed odds
      clvPct = Number(
        ((Number(current.odds) / args.closingSharpOdds - 1) * 100).toFixed(2),
      );
    } else if (current.softOdds) {
      // Non-placed: CLV against commission-adjusted soft odds at detection
      const commission = Number(current.softCommissionPct ?? 0);
      const adjSoftOdds = adjustOddsForCommission(
        Number(current.softOdds),
        commission,
      );
      clvPct = Number(
        ((adjSoftOdds / args.closingSharpOdds - 1) * 100).toFixed(2),
      );
    }
  }

  const [updated] = await db
    .update(bets)
    .set({
      closingSharpOdds: args.closingSharpOdds,
      clvPct: clvPct !== null ? Number(clvPct) : null,
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
