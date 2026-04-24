/**
 * Live-strategy types + repository + filter matcher.
 *
 * A `Strategy` is a configuration promoted from an optimizer trial (or
 * authored manually) that the value-detector consults on every detection
 * tick. When a detected `ValueBet` matches a strategy's `filters`, the
 * strategy claims the bet (its `strategy_id` is attached) and its
 * `sizing` overrides the global Kelly settings.
 *
 * Filter shape mirrors the search-space dimension naming so a trial config
 * can be promoted directly without re-mapping.
 */

import { desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import {
  optimizationStrategies,
  type OptimizationStrategyRow,
} from "../db/schema";

// ── Types ────────────────────────────────────────────────────────────────

export type StrategyStatus = "candidate" | "live" | "paused" | "retired";

export interface StrategyFilters {
  min_ev_pct?: number;
  max_odds_age_sec?: number;
  min_sharp_prob?: number;
  odds_lo?: number;
  odds_hi?: number;
  min_tick_count?: number;
  pre_match_only?: boolean;
  /** Whitelist — bet's softProvider must be one of these. */
  soft_providers?: string[];
  /** Whitelist — bet's marketType must be one of these. */
  market_types?: string[];
}

export interface StrategySizing {
  /** Kelly multiplier (0.0..1.0). Empirical sweet spot ≈ 0.25. */
  kelly_fraction: number;
  /** Max % of bankroll any single bet can risk. */
  kelly_cap_pct: number;
  /** "flat" | "kelly" | "sqrt_kelly" | "log_utility" */
  staking_scheme?: string;
}

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
      status: "candidate",
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

export async function listLiveStrategies(): Promise<OptimizationStrategyRow[]> {
  return db
    .select()
    .from(optimizationStrategies)
    .where(eq(optimizationStrategies.status, "live"));
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

export async function setStrategyStatus(
  id: string,
  status: StrategyStatus,
): Promise<OptimizationStrategyRow | null> {
  const now = new Date().toISOString();
  const sets: Record<string, unknown> = { status, updatedAt: now };
  if (status === "live") sets.activatedAt = now;
  if (status === "paused") sets.pausedAt = now;
  if (status === "retired") sets.retiredAt = now;

  const [row] = await db
    .update(optimizationStrategies)
    .set(sets)
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

// ── Matcher — pure function, used by lib/atoms/value-detector.ts ────────

export interface MatchableBet {
  evPct: number;
  sharpOddsAgeMs: number | null;
  sharpTrueProb: number;
  softOdds: number;
  softProvider: string;
  marketType: string;
  timeScope: string;
  tickCount?: number;
}

/**
 * Returns true if the supplied detected bet satisfies every filter on
 * the strategy. Missing filters are no-ops (treated as "no constraint").
 */
export function matchesStrategy(
  bet: MatchableBet,
  filters: StrategyFilters,
): boolean {
  if (typeof filters.min_ev_pct === "number" && bet.evPct < filters.min_ev_pct)
    return false;
  if (
    typeof filters.max_odds_age_sec === "number" &&
    bet.sharpOddsAgeMs !== null &&
    bet.sharpOddsAgeMs > filters.max_odds_age_sec * 1000
  )
    return false;
  if (
    typeof filters.min_sharp_prob === "number" &&
    bet.sharpTrueProb < filters.min_sharp_prob
  )
    return false;
  if (typeof filters.odds_lo === "number" && bet.softOdds < filters.odds_lo)
    return false;
  if (typeof filters.odds_hi === "number" && bet.softOdds > filters.odds_hi)
    return false;
  if (
    typeof filters.min_tick_count === "number" &&
    typeof bet.tickCount === "number" &&
    bet.tickCount < filters.min_tick_count
  )
    return false;
  if (filters.pre_match_only === true && bet.timeScope !== "pre_match")
    return false;
  if (
    Array.isArray(filters.soft_providers) &&
    filters.soft_providers.length > 0 &&
    !filters.soft_providers.includes(bet.softProvider)
  )
    return false;
  if (
    Array.isArray(filters.market_types) &&
    filters.market_types.length > 0 &&
    !filters.market_types.includes(bet.marketType)
  )
    return false;
  return true;
}

/**
 * Of the supplied live strategies, returns the FIRST whose filters this
 * bet matches. First-match wins — strategies are returned in creation
 * order from listLiveStrategies(). If there's overlap, the older
 * strategy claims the bet. (A future Phase could add an explicit
 * priority field if needed.)
 */
export function matchFirstLiveStrategy(
  bet: MatchableBet,
  liveStrategies: OptimizationStrategyRow[],
): OptimizationStrategyRow | null {
  for (const s of liveStrategies) {
    if (matchesStrategy(bet, s.filters as StrategyFilters)) return s;
  }
  return null;
}

export type { OptimizationStrategyRow };
