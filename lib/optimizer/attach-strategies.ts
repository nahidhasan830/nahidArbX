/**
 * Attach matching live-strategy IDs to detected value bets.
 *
 * Called from the sync pipeline AFTER value detection but BEFORE
 * `persistValueBets`. For each detected bet, finds the first matching
 * live strategy (by filters) and writes its id onto the bet. When no
 * strategy matches, `strategyId` stays null — the bet is still detected
 * + persisted, just not attributed to any strategy.
 *
 * The cache lookup is cheap (in-memory, 60s TTL) so this adds <1ms
 * even when there are many detected bets.
 */

import type { ValueBet } from "../atoms/value-detector";
import { getFamily } from "../atoms/registry";
import { getLiveStrategies } from "./live-strategies-cache";
import { matchFirstLiveStrategy } from "./strategies";

export async function attachStrategyMatches(
  bets: ValueBet[],
): Promise<ValueBet[]> {
  if (bets.length === 0) return bets;
  const liveStrategies = await getLiveStrategies();
  if (liveStrategies.length === 0) return bets;

  for (const bet of bets) {
    // marketType + timeScope live on the family in the registry; tickCount
    // is computed at persist time so the matcher tolerates undefined for it.
    const family = getFamily(bet.familyId);
    const matched = matchFirstLiveStrategy(
      {
        evPct: bet.evPct,
        sharpOddsAgeMs: bet.sharpOddsAgeMs,
        sharpTrueProb: bet.trueProb,
        softOdds: bet.softOdds,
        softProvider: bet.softProvider,
        marketType: family?.market_type ?? "",
        timeScope: family?.time_scope ?? "pre_match",
        tickCount: undefined,
      },
      liveStrategies,
    );
    if (matched) {
      bet.strategyId = matched.id;
    }
  }
  return bets;
}
