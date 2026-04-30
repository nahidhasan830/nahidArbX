/**
 * Pure types + filter matcher for strategies.
 *
 * Extracted from strategies.ts so both server-side (Drizzle queries) and
 * client-side (React components) can import without pulling in DB deps.
 */

export interface StrategyFilters {
  min_ev_pct?: number;

  min_sharp_prob?: number;
  odds_lo?: number;
  odds_hi?: number;
  min_tick_count?: number;
  pre_match_only?: boolean;
  soft_providers?: string[];
  market_types?: string[];
}

export interface StrategySizing {
  kelly_fraction: number;
  kelly_cap_pct: number;
  staking_scheme?: string;
}

export interface MatchableBet {
  evPct: number;

  sharpTrueProb: number;
  softOdds: number;
  softProvider: string;
  marketType: string;
  timeScope: string;
  tickCount?: number;
}

export function matchesStrategy(
  bet: MatchableBet,
  filters: StrategyFilters,
): boolean {
  if (typeof filters.min_ev_pct === "number" && bet.evPct < filters.min_ev_pct)
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
