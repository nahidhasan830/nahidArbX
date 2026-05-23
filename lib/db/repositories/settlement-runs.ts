/**
 * Repository for the `settlement_runs` telemetry log. Writes are
 * append-only — we never update a prior row, so each tick ends with
 * exactly one INSERT.
 */

import { desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../client";
import {
  settlementRuns,
  type NewSettlementRunRow,
  type SettlementRunRow,
} from "../schema";

export type SettlementRunInput = Omit<
  NewSettlementRunRow,
  "id" | "startedAt" | "finishedAt"
> & {
  startedAt: string;
  finishedAt: string;
};

/**
 * Settlement is source-only, so current runs have no variable AI cost.
 * Historical rows may still contain tier3/tier4 hits from old migrations.
 */
const TIER_COST_USD = {
  tier0: 0,
  tier1: 0,
  tier2: 0,
  tier3: 0,
  tier4: 0,
} as const;

export const estimateRunCost = (
  t0: number,
  t1: number,
  t2: number,
  t3: number,
  t4: number,
): number => {
  return (
    t0 * TIER_COST_USD.tier0 +
    t1 * TIER_COST_USD.tier1 +
    t2 * TIER_COST_USD.tier2 +
    t3 * TIER_COST_USD.tier3 +
    t4 * TIER_COST_USD.tier4
  );
};

export const recordSettlementRun = async (
  input: SettlementRunInput,
): Promise<void> => {
  await db.insert(settlementRuns).values({
    id: randomUUID(),
    ...input,
  });
};

export const listRecentSettlementRuns = async (
  limit = 50,
): Promise<SettlementRunRow[]> => {
  return db
    .select()
    .from(settlementRuns)
    .orderBy(desc(settlementRuns.startedAt))
    .limit(limit);
};
