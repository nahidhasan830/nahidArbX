/**
 * Strategy types + repository.
 *
 * A `Strategy` is a saved filter + sizing recommendation, promoted from an
 * optimizer trial (or authored manually). It does NOT tag bets — live ROI
 * is computed by re-applying `filters` to the bets table via SQL whenever
 * the UI or validation cron asks for it.
 *
 * Lifecycle is just "available" vs "archived":
 *   - retiredAt IS NULL → available (selectable in spreadsheet pickers
 *     and as a settings-level auto-place gate)
 *   - retiredAt IS NOT NULL → archived (hidden from default lists, can
 *     be restored)
 *
 * "Active" is no longer a strategy state — it's determined by membership
 * in `betting_settings.active_strategy_ids`.
 */

import { desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import {
  optimizationStrategies,
  type OptimizationStrategyRow,
} from "../db/schema";
import type { StrategyFilters, StrategySizing } from "./strategy-filters";

// Re-export the pure types so existing callers keep working.
export type { StrategyFilters, StrategySizing };
export { matchesStrategy, type MatchableBet } from "./strategy-filters";

export interface PromoteRequest {
  /** Optimizer trial that produced this config — NOT a manual creation. */
  trialId: string;
  runId: string;
  name: string;
  description?: string;
  filters: StrategyFilters;
  sizing: StrategySizing;
  metricsSnapshot: Record<string, unknown>;
  createdBy?: string;
}

// ── ID helper (matches the repository.ts pattern) ───────────────────────

const ulidLike = (): string => {
  const ts = Date.now().toString(36).padStart(10, "0");
  const rand = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36),
  ).join("");
  return `${ts}${rand}`.toUpperCase();
};

// ── Repository ───────────────────────────────────────────────────────────

export async function promoteStrategy(
  req: PromoteRequest,
): Promise<OptimizationStrategyRow> {
  const id = ulidLike();
  const [row] = await db
    .insert(optimizationStrategies)
    .values({
      id,
      name: req.name,
      description: req.description ?? null,
      source: "optimizer",
      sourceRunId: req.runId,
      sourceTrialId: req.trialId,
      filters: req.filters,
      sizing: req.sizing,
      metricsSnapshot: req.metricsSnapshot,
      createdBy: req.createdBy ?? null,
    })
    .returning();
  return row;
}

export async function listStrategies(): Promise<OptimizationStrategyRow[]> {
  return db
    .select()
    .from(optimizationStrategies)
    .orderBy(desc(optimizationStrategies.createdAt));
}

/** Available (non-retired) strategies, newest first. */
export async function listAvailableStrategies(): Promise<
  OptimizationStrategyRow[]
> {
  return db
    .select()
    .from(optimizationStrategies)
    .where(isNull(optimizationStrategies.retiredAt))
    .orderBy(desc(optimizationStrategies.createdAt));
}

export async function getStrategy(
  id: string,
): Promise<OptimizationStrategyRow | null> {
  const rows = await db
    .select()
    .from(optimizationStrategies)
    .where(eq(optimizationStrategies.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function retireStrategy(
  id: string,
): Promise<OptimizationStrategyRow | null> {
  const now = new Date().toISOString();
  const [row] = await db
    .update(optimizationStrategies)
    .set({ retiredAt: now, updatedAt: now })
    .where(eq(optimizationStrategies.id, id))
    .returning();
  return row ?? null;
}

export async function unretireStrategy(
  id: string,
): Promise<OptimizationStrategyRow | null> {
  const now = new Date().toISOString();
  const [row] = await db
    .update(optimizationStrategies)
    .set({ retiredAt: null, updatedAt: now })
    .where(eq(optimizationStrategies.id, id))
    .returning();
  return row ?? null;
}

export async function updateLiveMetrics(
  id: string,
  metrics: Record<string, unknown>,
): Promise<void> {
  await db
    .update(optimizationStrategies)
    .set({
      liveMetrics: metrics,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(optimizationStrategies.id, id));
}

export type { OptimizationStrategyRow };
