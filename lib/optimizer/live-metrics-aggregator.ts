/**
 * Per-strategy live-metrics aggregator.
 *
 * For every active (live OR paused) strategy, compute since-promotion
 * metrics by re-applying the strategy's filters to the `bets` table. No
 * per-bet attribution column is involved — the strategy IS its filter, and
 * its live ROI is whatever those filters currently select. Writes results
 * to `optimization_strategies.live_metrics` so the UI can show
 * live-vs-OOS divergence at a glance.
 *
 * Runs from the existing optimizer scheduler tick (no separate timer).
 * One aggregate query per strategy, all predicates pushed to Postgres.
 */

import { and, sql } from "drizzle-orm";
import { db } from "../db/client";
import { bets } from "../db/schema";
import { logger } from "../shared/logger";
import {
  listStrategies,
  updateLiveMetrics,
  type StrategyFilters,
} from "./strategies";
import { buildStrategyFilterClauses } from "./strategy-filter-sql";

const tag = "LiveMetricsAggregator";

export async function recomputeLiveMetrics(): Promise<{
  strategiesScanned: number;
  updated: number;
}> {
  const all = await listStrategies();
  const targets = all.filter((s) => s.retiredAt == null);
  let updated = 0;

  for (const s of targets) {
    try {
      const clauses = buildStrategyFilterClauses(s.filters as StrategyFilters);
      const where = clauses.length ? and(...clauses) : undefined;

      const [r] = await db
        .select({
          nTotal: sql<number>`COUNT(*)::int`,
          nSettled: sql<number>`COUNT(*) FILTER (WHERE ${bets.outcome} IN ('won','half_won','lost','half_lost','void'))::int`,
          nWon: sql<number>`COUNT(*) FILTER (WHERE ${bets.outcome} = 'won')::int`,
          nHalfWon: sql<number>`COUNT(*) FILTER (WHERE ${bets.outcome} = 'half_won')::int`,
          nLost: sql<number>`COUNT(*) FILTER (WHERE ${bets.outcome} = 'lost')::int`,
          nHalfLost: sql<number>`COUNT(*) FILTER (WHERE ${bets.outcome} = 'half_lost')::int`,
          totalStake: sql<number>`COALESCE(SUM(${bets.stake}) FILTER (WHERE ${bets.placedAt} IS NOT NULL), 0)::float`,
          totalPnl: sql<number>`COALESCE(SUM(${bets.pnl}) FILTER (WHERE ${bets.placedAt} IS NOT NULL), 0)::float`,
          meanClvPct: sql<
            number | null
          >`AVG(${bets.clvPct}) FILTER (WHERE ${bets.clvPct} IS NOT NULL)::float`,
        })
        .from(bets)
        .where(where);

      if (!r) continue;

      const winWeighted = r.nWon + r.nHalfWon * 0.5;
      const winRatePct =
        r.nSettled > 0 ? (winWeighted / r.nSettled) * 100 : null;
      const liveRoiPct =
        r.totalStake !== null && r.totalStake > 0
          ? ((r.totalPnl ?? 0) / r.totalStake) * 100
          : null;

      const snapshot = (s.metricsSnapshot as Record<string, unknown>) ?? {};
      const oosRoi = snapshot["oosRoiMean"];
      const oosCiLow = snapshot["oosRoiCiLow"];
      const oosCiHigh = snapshot["oosRoiCiHigh"];

      // Drift signal: "outside CI" = live ROI is outside the OOS bootstrap
      // CI band. Used by the UI to show a red dot next to drifting strategies.
      let outsideOosCi: boolean | null = null;
      if (
        liveRoiPct !== null &&
        typeof oosCiLow === "number" &&
        typeof oosCiHigh === "number"
      ) {
        outsideOosCi = liveRoiPct < oosCiLow || liveRoiPct > oosCiHigh;
      }

      await updateLiveMetrics(s.id, {
        nTotal: r.nTotal,
        nSettled: r.nSettled,
        nWon: r.nWon,
        nLost: r.nLost,
        totalStake: r.totalStake,
        totalPnl: r.totalPnl,
        liveRoiPct,
        winRatePct,
        meanClvPct: r.meanClvPct,
        oosRoiMean: typeof oosRoi === "number" ? oosRoi : null,
        outsideOosCi,
        recomputedAt: new Date().toISOString(),
      });
      updated += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(tag, `Strategy ${s.id} aggregate failed: ${msg}`);
    }
  }

  if (updated > 0) {
    logger.info(
      tag,
      `Live metrics recomputed for ${updated}/${targets.length} strategies`,
    );
  }
  return { strategiesScanned: targets.length, updated };
}
