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
 * Per-tier cost rates used by the recorder to stamp an estimated cost
 * onto each row. Kept in-sync with scripts/test-settlement.ts's cost
 * model so historical rows stay comparable.
 */
const TIER_COST_USD = {
  tier0: 0,
  tier1: 0,
  tier2: 0,
  tier3: 0.0015,
  tier4: 0.0283,
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
