/**
 * Repository for durable ML prediction snapshots.
 *
 * Write side is deliberately tolerant: audit failures must never block live
 * value detection, scoring, settlement, or placement.
 */
import { and, desc, eq, getTableColumns, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../client";
import {
  bets,
  mlPredictionAudit,
  type MlPredictionAuditRow,
  type NewMlPredictionAuditRow,
} from "../schema";
import { logger } from "@/lib/shared/logger";
import { buildPredictionKey } from "@/lib/ml/prediction-audit-key";

export type MlPredictionDecision = "boost" | "shrink" | "skip" | "agree";

export type PredictionAuditInput = Omit<
  NewMlPredictionAuditRow,
  "id" | "createdAt" | "predictionKey" | "outcome"
> & {
  outcome?: string;
};

export type PredictionAuditFilters = {
  from?: string;
  to?: string;
  modelVersion?: number;
  decisions?: string[];
  marketTypes?: string[];
  eventId?: string;
  settled?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
};

export type SettlementMirrorInput = {
  betId: string;
  outcome: string;
  pnl: number | null;
  clvPct: number | null;
  settledAt: string | null;
};

export type PredictionAuditRowWithPlacement = MlPredictionAuditRow & {
  placementPlacedAt: string | null;
  placementStake: number | null;
  placementOdds: number | null;
  placementProviderTicketId: string | null;
  placementMode: string | null;
  placementPnl: number | null;
  placementClvPct: number | null;
  placementMlScore: number | null;
  placementMlModelEdgePct: number | null;
  placementMlDecision: string | null;
  placementMlKellyMultiplier: number | null;
  placementMlModelVersion: number | null;
};

const tag = "MLPredictionAudit";

export async function recordPredictionBatch(
  inputs: PredictionAuditInput[],
): Promise<void> {
  const rowByBetId = new Map<string, NewMlPredictionAuditRow>();
  for (const row of inputs
    .filter((input) => Number.isFinite(input.mlScore))
    .map((input) => ({
      ...input,
      predictionKey: buildPredictionKey({
        betId: input.betId,
        modelVersion: input.modelVersion ?? null,
        softProvider: input.softProvider,
        softOdds: Number(input.softOdds),
        sharpOdds: Number(input.sharpOdds),
        mlScore: Number(input.mlScore),
        modelEdgePct: input.modelEdgePct ?? null,
        mlFeatureVersion: input.mlFeatureVersion,
        mlFeatureNamesHash: input.mlFeatureNamesHash,
      }),
      outcome: input.outcome ?? "pending",
    }))) {
    rowByBetId.set(row.betId, row);
  }

  const rows = [...rowByBetId.values()];

  if (rows.length === 0) return;

  try {
    await db
      .insert(mlPredictionAudit)
      .values(rows)
      .onConflictDoUpdate({
        target: mlPredictionAudit.betId,
        set: {
          predictionKey: sql`excluded.prediction_key`,
          scoredAt: sql`excluded.scored_at`,
          eventId: sql`excluded.event_id`,
          familyId: sql`excluded.family_id`,
          atomId: sql`excluded.atom_id`,
          atomLabel: sql`excluded.atom_label`,
          homeTeam: sql`excluded.home_team`,
          awayTeam: sql`excluded.away_team`,
          competition: sql`excluded.competition`,
          eventStartTime: sql`excluded.event_start_time`,
          marketType: sql`excluded.market_type`,
          timeScope: sql`excluded.time_scope`,
          familyLine: sql`excluded.family_line`,
          softProvider: sql`excluded.soft_provider`,
          softOdds: sql`excluded.soft_odds`,
          softCommissionPct: sql`excluded.soft_commission_pct`,
          sharpProvider: sql`excluded.sharp_provider`,
          sharpOdds: sql`excluded.sharp_odds`,
          sharpTrueProb: sql`excluded.sharp_true_prob`,
          baselineEvPct: sql`excluded.baseline_ev_pct`,
          baselineKellyFraction: sql`excluded.baseline_kelly_fraction`,
          modelVersion: sql`excluded.model_version`,
          mlScore: sql`excluded.ml_score`,
          modelEdgePct: sql`excluded.model_edge_pct`,
          kellyMultiplier: sql`excluded.kelly_multiplier`,
          mlStakeFraction: sql`excluded.ml_stake_fraction`,
          decision: sql`excluded.decision`,
          permissionLevel: sql`excluded.permission_level`,
          mlFeatures: sql`excluded.ml_features`,
          mlFeatureVersion: sql`excluded.ml_feature_version`,
          mlFeatureCount: sql`excluded.ml_feature_count`,
          mlFeatureNamesHash: sql`excluded.ml_feature_names_hash`,
          outcome: sql`CASE
            WHEN ${mlPredictionAudit.outcome} <> 'pending'
              AND excluded.outcome = 'pending'
            THEN ${mlPredictionAudit.outcome}
            ELSE excluded.outcome
          END`,
          pnl: sql`CASE
            WHEN ${mlPredictionAudit.outcome} <> 'pending'
              AND excluded.outcome = 'pending'
              AND excluded.pnl IS NULL
            THEN ${mlPredictionAudit.pnl}
            ELSE excluded.pnl
          END`,
          clvPct: sql`CASE
            WHEN ${mlPredictionAudit.outcome} <> 'pending'
              AND excluded.outcome = 'pending'
              AND excluded.clv_pct IS NULL
            THEN ${mlPredictionAudit.clvPct}
            ELSE excluded.clv_pct
          END`,
          settledAt: sql`CASE
            WHEN ${mlPredictionAudit.outcome} <> 'pending'
              AND excluded.outcome = 'pending'
              AND excluded.settled_at IS NULL
            THEN ${mlPredictionAudit.settledAt}
            ELSE excluded.settled_at
          END`,
        },
      });
  } catch (err) {
    logger.warn(
      tag,
      `Failed to record prediction batch: ${(err as Error).message}`,
    );
  }
}

function buildFilterClauses(filters: PredictionAuditFilters) {
  const clauses = [];
  if (filters.from) clauses.push(gte(mlPredictionAudit.scoredAt, filters.from));
  if (filters.to) clauses.push(lte(mlPredictionAudit.scoredAt, filters.to));
  if (filters.modelVersion != null) {
    clauses.push(eq(mlPredictionAudit.modelVersion, filters.modelVersion));
  }
  if (filters.decisions?.length) {
    clauses.push(inArray(mlPredictionAudit.decision, filters.decisions));
  }
  if (filters.marketTypes?.length) {
    clauses.push(inArray(mlPredictionAudit.marketType, filters.marketTypes));
  }
  if (filters.eventId)
    clauses.push(eq(mlPredictionAudit.eventId, filters.eventId));
  if (filters.settled === true) {
    clauses.push(sql`${mlPredictionAudit.outcome} <> 'pending'`);
  }
  if (filters.settled === false) {
    clauses.push(eq(mlPredictionAudit.outcome, "pending"));
  }
  if (filters.search) {
    const q = `%${filters.search}%`;
    clauses.push(sql`(
      ${mlPredictionAudit.homeTeam} ILIKE ${q}
      OR ${mlPredictionAudit.awayTeam} ILIKE ${q}
      OR COALESCE(${mlPredictionAudit.competition}, '') ILIKE ${q}
      OR ${mlPredictionAudit.atomLabel} ILIKE ${q}
      OR ${mlPredictionAudit.marketType} ILIKE ${q}
    )`);
  }
  return clauses;
}

export async function listPredictionAuditRows(
  filters: PredictionAuditFilters = {},
): Promise<{ rows: PredictionAuditRowWithPlacement[]; total: number }> {
  const clauses = buildFilterClauses(filters);
  const where = clauses.length ? and(...clauses) : undefined;
  const predictionColumns = getTableColumns(mlPredictionAudit);

  const rows = await db
    .select({
      ...predictionColumns,
      placementPlacedAt: bets.placedAt,
      placementStake: bets.stake,
      placementOdds: bets.odds,
      placementProviderTicketId: bets.providerTicketId,
      placementMode: bets.mode,
      placementPnl: bets.pnl,
      placementClvPct: bets.clvPct,
      placementMlScore: bets.placedMlScore,
      placementMlModelEdgePct: bets.placedMlModelEdgePct,
      placementMlDecision: bets.placedMlDecision,
      placementMlKellyMultiplier: bets.placedMlKellyMultiplier,
      placementMlModelVersion: bets.placedMlModelVersion,
    })
    .from(mlPredictionAudit)
    .leftJoin(bets, eq(bets.id, mlPredictionAudit.betId))
    .where(where)
    .orderBy(desc(mlPredictionAudit.scoredAt), desc(mlPredictionAudit.id))
    .limit(filters.limit ?? 200)
    .offset(filters.offset ?? 0);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mlPredictionAudit)
    .where(where);

  return { rows, total: count ?? 0 };
}

export async function attachSettlementOutcomes(
  inputs: SettlementMirrorInput[],
): Promise<void> {
  for (const input of inputs) {
    try {
      await db
        .update(mlPredictionAudit)
        .set({
          outcome: input.outcome,
          pnl: input.pnl,
          clvPct: input.clvPct,
          settledAt: input.settledAt,
        })
        .where(eq(mlPredictionAudit.betId, input.betId));
    } catch (err) {
      logger.warn(
        tag,
        `Failed to mirror settlement for ${input.betId}: ${(err as Error).message}`,
      );
    }
  }
}
