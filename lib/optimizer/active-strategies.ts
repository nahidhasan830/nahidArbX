/**
 * Active-strategies cache for the auto-placer.
 *
 * Caches the list of strategies whose IDs appear in
 * `betting_settings.active_strategy_ids`, refreshing at most once per
 * minute. The settings route and retire route call
 * `invalidateActiveStrategiesCache()` to force a fresh load on the next
 * auto-place tick.
 */

import type { OptimizationStrategyRow } from "../db/schema";
import { getStrategy } from "./strategies";
import { matchesStrategy } from "./strategy-filters";
import type { StrategyFilters, MatchableBet } from "./strategy-filters";

type LooseBet = Partial<MatchableBet> & {
  evPct: number;
  softOdds: number;
  softProvider: string;
};

let cached: OptimizationStrategyRow[] | null = null;
let cachedAt = 0;
const TTL_MS = 60_000;

export function invalidateActiveStrategiesCache(): void {
  cached = null;
  cachedAt = 0;
}

export async function getActiveStrategies(
  ids: string[],
): Promise<OptimizationStrategyRow[]> {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;

  const results: OptimizationStrategyRow[] = [];
  for (const id of ids) {
    const s = await getStrategy(id);
    if (s && s.retiredAt == null) results.push(s);
  }
  cached = results;
  cachedAt = Date.now();
  return results;
}

export function findMatchingActiveStrategy(
  bet: LooseBet,
  strategies: OptimizationStrategyRow[],
): OptimizationStrategyRow | null {
  const full: MatchableBet = {
    evPct: bet.evPct,
    sharpOddsAgeMs: bet.sharpOddsAgeMs ?? null,
    sharpTrueProb: bet.sharpTrueProb ?? 0,
    softOdds: bet.softOdds,
    softProvider: bet.softProvider,
    marketType: bet.marketType ?? "",
    timeScope: bet.timeScope ?? "pre_match",
    tickCount: bet.tickCount,
  };
  for (const s of strategies) {
    if (matchesStrategy(full, s.filters as StrategyFilters)) return s;
  }
  return null;
}
