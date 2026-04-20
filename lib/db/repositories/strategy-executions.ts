import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../client";
import { strategyExecutions, valueBets } from "../schema";
import type { ValueBetRow } from "../schema";

export type ExecutionRow = {
  executionId: string;
  matchedAt: string;
  stakeMultiplier: number;
  // Denormalised from value_bets via LEFT JOIN
  valueBet: ValueBetRow | null;
};

export type StrategySummary = {
  strategyId: string;
  totalExecutions: number;
  settled: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  roiPct: number | null;
  clvPct: number | null;
};

/**
 * Insert executions for strategy × value_bet matches that don't yet have one.
 * Idempotent via ON CONFLICT on the (strategy_id, value_bet_id) unique index.
 * Returns count actually inserted.
 */
export const recordExecutions = async (
  strategyId: string,
  valueBetIds: string[],
  stakeMultiplier: number,
): Promise<number> => {
  if (valueBetIds.length === 0) return 0;
  const values = valueBetIds.map((id) => ({
    id: crypto.randomUUID(),
    strategyId,
    valueBetId: id,
    stakeMultiplier,
  }));
  const result = await db
    .insert(strategyExecutions)
    .values(values)
    .onConflictDoNothing({
      target: [strategyExecutions.strategyId, strategyExecutions.valueBetId],
    })
    .returning({ id: strategyExecutions.id });
  return result.length;
};

export const listExecutionsForStrategy = async (
  strategyId: string,
  limit = 200,
): Promise<ExecutionRow[]> => {
  const rows = await db
    .select({
      executionId: strategyExecutions.id,
      matchedAt: strategyExecutions.matchedAt,
      stakeMultiplier: strategyExecutions.stakeMultiplier,
      valueBet: valueBets,
    })
    .from(strategyExecutions)
    .leftJoin(valueBets, eq(valueBets.id, strategyExecutions.valueBetId))
    .where(eq(strategyExecutions.strategyId, strategyId))
    .orderBy(desc(strategyExecutions.matchedAt))
    .limit(limit);

  return rows.map((r) => ({
    executionId: r.executionId,
    matchedAt: r.matchedAt,
    stakeMultiplier: r.stakeMultiplier,
    valueBet: (r.valueBet ?? null) as ValueBetRow | null,
  }));
};

/**
 * Already-tracked value_bet ids for a strategy — used by the matcher to
 * avoid re-scanning bets it's already recorded.
 */
export const existingExecutionBetIds = async (
  strategyId: string,
  candidateIds: string[],
): Promise<Set<string>> => {
  if (candidateIds.length === 0) return new Set();
  const existing = await db
    .select({ id: strategyExecutions.valueBetId })
    .from(strategyExecutions)
    .where(
      and(
        eq(strategyExecutions.strategyId, strategyId),
        inArray(strategyExecutions.valueBetId, candidateIds),
      ),
    );
  return new Set(existing.map((r) => r.id));
};

/**
 * Summary metrics per strategy — derived live from value_bets via the
 * executions join. Single round-trip for a batch of strategies.
 */
export const summarizeStrategies = async (
  strategyIds: string[],
): Promise<Record<string, StrategySummary>> => {
  if (strategyIds.length === 0) return {};

  // EV using soft_odds_max and commission (matches derive.ts formula).
  // Settlement P&L books wins at softOddsFirst (entry price) — matches
  // settlementPnl() in lib/backtest/derive.ts.
  const pnlExpr = sql`CASE
    WHEN ${valueBets.outcome} = 'won'
      THEN (${valueBets.softOddsFirst} - 1) * (1 - ${valueBets.softCommissionPct} / 100)
    WHEN ${valueBets.outcome} = 'lost' THEN -1
    ELSE 0
  END`;
  const stakedExpr = sql`CASE WHEN ${valueBets.outcome} IN ('won','lost') THEN 1 ELSE 0 END`;
  const clvExpr = sql`CASE WHEN ${valueBets.closingSharpOdds} IS NOT NULL
    THEN (${valueBets.softOddsFirst} / ${valueBets.closingSharpOdds}) - 1
    ELSE NULL END`;

  const rows = await db
    .select({
      strategyId: strategyExecutions.strategyId,
      total: sql<number>`count(*)::int`,
      wins: sql<number>`sum(CASE WHEN ${valueBets.outcome} = 'won' THEN 1 ELSE 0 END)::int`,
      losses: sql<number>`sum(CASE WHEN ${valueBets.outcome} = 'lost' THEN 1 ELSE 0 END)::int`,
      totalStaked: sql<number>`sum(${stakedExpr})::float`,
      totalReturn: sql<number>`sum(${pnlExpr})::float`,
      clvCount: sql<number>`sum(CASE WHEN ${valueBets.closingSharpOdds} IS NOT NULL THEN 1 ELSE 0 END)::int`,
      clvSum: sql<number>`sum(COALESCE(${clvExpr}, 0))::float`,
    })
    .from(strategyExecutions)
    .leftJoin(valueBets, eq(valueBets.id, strategyExecutions.valueBetId))
    .where(inArray(strategyExecutions.strategyId, strategyIds))
    .groupBy(strategyExecutions.strategyId);

  const map: Record<string, StrategySummary> = {};
  for (const id of strategyIds) {
    map[id] = {
      strategyId: id,
      totalExecutions: 0,
      settled: 0,
      wins: 0,
      losses: 0,
      winRatePct: null,
      roiPct: null,
      clvPct: null,
    };
  }
  for (const r of rows) {
    const wins = r.wins ?? 0;
    const losses = r.losses ?? 0;
    const decided = wins + losses;
    const settled = decided; // voids/pushes not settled for ROI purposes
    map[r.strategyId] = {
      strategyId: r.strategyId,
      totalExecutions: r.total ?? 0,
      settled,
      wins,
      losses,
      winRatePct: decided > 0 ? (wins / decided) * 100 : null,
      roiPct:
        r.totalStaked && r.totalStaked > 0
          ? (r.totalReturn / r.totalStaked) * 100
          : null,
      clvPct: r.clvCount > 0 ? (r.clvSum / r.clvCount) * 100 : null,
    };
  }
  return map;
};
