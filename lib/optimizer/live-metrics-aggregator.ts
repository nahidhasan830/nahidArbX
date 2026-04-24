/**
 * Per-strategy live-metrics aggregator.
 *
 * For every active (live OR paused) strategy, compute since-promotion
 * metrics from `bets WHERE strategy_id = X AND outcome IS NOT NULL`.
 * Writes results to `optimization_strategies.live_metrics` so the UI can
 * show live-vs-OOS divergence at a glance.
 *
 * Runs from the existing optimizer scheduler tick (no separate timer).
 * Cheap query — typically <50 strategies × ~1k matching bets each.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { logger } from "../shared/logger";
import { listStrategies, updateLiveMetrics } from "./strategies";

const tag = "LiveMetricsAggregator";

interface AggregateRow {
  n_total: number;
  n_settled: number;
  n_won: number;
  n_lost: number;
  total_stake: number | null;
  total_pnl: number | null;
  mean_clv_pct: number | null;
}

export async function recomputeLiveMetrics(): Promise<{
  strategiesScanned: number;
  updated: number;
}> {
  const all = await listStrategies();
  const targets = all.filter(
    (s) => s.status === "live" || s.status === "paused",
  );
  let updated = 0;

  for (const s of targets) {
    try {
      const result = await db.execute(
        sql`SELECT
              COUNT(*)::int                                                      AS n_total,
              COUNT(*) FILTER (WHERE outcome IN ('won','half_won','lost','half_lost','void'))::int
                                                                                  AS n_settled,
              COUNT(*) FILTER (WHERE outcome IN ('won','half_won'))::int          AS n_won,
              COUNT(*) FILTER (WHERE outcome IN ('lost','half_lost'))::int        AS n_lost,
              COALESCE(SUM(stake) FILTER (WHERE placed_at IS NOT NULL), 0)::float AS total_stake,
              COALESCE(SUM(pnl)   FILTER (WHERE placed_at IS NOT NULL), 0)::float AS total_pnl,
              AVG(clv_pct)        FILTER (WHERE clv_pct IS NOT NULL)::float       AS mean_clv_pct
            FROM bets WHERE strategy_id = ${s.id}`,
      );
      const r = (result.rows[0] as unknown as AggregateRow | undefined) ?? null;
      if (!r) continue;

      const winRatePct =
        r.n_won + r.n_lost > 0 ? (r.n_won / (r.n_won + r.n_lost)) * 100 : null;
      const liveRoiPct =
        r.total_stake !== null && r.total_stake > 0
          ? ((r.total_pnl ?? 0) / r.total_stake) * 100
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
        nTotal: r.n_total,
        nSettled: r.n_settled,
        nWon: r.n_won,
        nLost: r.n_lost,
        totalStake: r.total_stake,
        totalPnl: r.total_pnl,
        liveRoiPct,
        winRatePct,
        meanClvPct: r.mean_clv_pct,
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
