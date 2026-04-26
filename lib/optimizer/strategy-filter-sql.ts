/**
 * Translate a StrategyFilters object into Drizzle SQL WHERE clauses
 * against the `bets` table. Used by the live-metrics aggregator and
 * the strategy detail route to find bets matching a strategy's filters.
 */

import { sql, type SQL } from "drizzle-orm";
import { bets } from "../db/schema";
import type { StrategyFilters } from "./strategy-filters";

export function buildStrategyFilterClauses(filters: StrategyFilters): SQL[] {
  const clauses: SQL[] = [];

  if (typeof filters.min_ev_pct === "number") {
    // EV% = (softOdds * sharpTrueProb - 1) * 100 (ignoring commission for simplicity)
    clauses.push(
      sql`(${bets.softOdds} * ${bets.sharpTrueProb} - 1) * 100 >= ${filters.min_ev_pct}`,
    );
  }
  if (typeof filters.odds_lo === "number") {
    clauses.push(sql`${bets.softOdds} >= ${filters.odds_lo}`);
  }
  if (typeof filters.odds_hi === "number") {
    clauses.push(sql`${bets.softOdds} <= ${filters.odds_hi}`);
  }
  if (
    Array.isArray(filters.soft_providers) &&
    filters.soft_providers.length > 0
  ) {
    clauses.push(sql`${bets.softProvider} = ANY(${filters.soft_providers})`);
  }
  if (Array.isArray(filters.market_types) && filters.market_types.length > 0) {
    clauses.push(sql`${bets.marketType} = ANY(${filters.market_types})`);
  }
  if (filters.pre_match_only === true) {
    clauses.push(sql`${bets.timeScope} = 'pre_match'`);
  }

  return clauses;
}
