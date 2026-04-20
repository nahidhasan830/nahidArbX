/**
 * Live strategy matching.
 *
 * Runs after each value-bet persist cycle. For every strategy with
 * status='live', finds value_bets that match the strategy's filters and
 * records an execution (idempotent — unique index on strategy_id + value_bet_id).
 *
 * Scope is bounded: each strategy query caps at 1000 rows. On a 30s sync
 * cycle this adds <100ms of DB time even with many live strategies.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { strategies } from "@/lib/db/schema";
import {
  listValueBets,
  type ListFilters,
} from "@/lib/db/repositories/value-bets";
import {
  existingExecutionBetIds,
  recordExecutions,
} from "@/lib/db/repositories/strategy-executions";
import { logger } from "@/lib/shared/logger";

export type MatcherResult = {
  liveStrategies: number;
  totalInserted: number;
  perStrategy: { id: string; name: string; inserted: number }[];
};

export async function runStrategyMatcher(): Promise<MatcherResult> {
  const liveStrategies = await db
    .select()
    .from(strategies)
    .where(eq(strategies.status, "live"));

  const result: MatcherResult = {
    liveStrategies: liveStrategies.length,
    totalInserted: 0,
    perStrategy: [],
  };

  if (liveStrategies.length === 0) return result;

  for (const strat of liveStrategies) {
    try {
      const filters = (strat.filters ?? {}) as ListFilters;
      // Pull every matching row — the unique index in strategy_executions
      // discards duplicates we've seen before, so we're free to re-scan.
      const { rows } = await listValueBets({
        ...filters,
        limit: 1000,
        offset: 0,
      });
      const candidateIds = rows.map((r) => r.id);

      const alreadyTracked = await existingExecutionBetIds(
        strat.id,
        candidateIds,
      );
      const newIds = candidateIds.filter((id) => !alreadyTracked.has(id));
      const inserted = await recordExecutions(
        strat.id,
        newIds,
        strat.stakeMultiplier,
      );

      result.totalInserted += inserted;
      result.perStrategy.push({
        id: strat.id,
        name: strat.name,
        inserted,
      });
    } catch (err) {
      logger.warn(
        "StrategyMatcher",
        `Strategy ${strat.id} (${strat.name}) failed: ${(err as Error).message}`,
      );
    }
  }

  if (result.totalInserted > 0) {
    logger.info(
      "StrategyMatcher",
      `Recorded ${result.totalInserted} executions across ${result.liveStrategies} live strategies`,
    );
  }

  return result;
}
