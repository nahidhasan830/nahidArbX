/**
 * Auto-validation — periodic re-evaluation of live strategies + drift-based
 * auto-pause.
 *
 * Cadence: once every 7 days (compared against the last `ran_at` for the
 * strategy in `strategy_validations`). Cheap query — typically <50 live
 * strategies × ~1k matching bets each.
 *
 * Drift detection logic:
 *   - Compare since-promotion live ROI to the snapshot's OOS ROI CI band.
 *   - If outside the band → drift_flag=true, consecutive_drifts++.
 *   - If inside → drift_flag=false, consecutive_drifts reset to 0.
 *   - 3 consecutive drifts → set strategy.status='paused' + write note.
 *
 * Why 3 in a row: one drift could be noise (CI is 95% by construction, so
 * 5% of clean strategies will trip it on any given check). Three in a row
 * = (~5%)^3 ≈ 0.01% if the underlying ROI hasn't moved → much stronger
 * signal that something has actually shifted.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { logger } from "../shared/logger";
import { invalidateLiveStrategiesCache } from "./live-strategies-cache";
import { listStrategies, setStrategyStatus } from "./strategies";

const tag = "AutoValidation";
const CHECK_INTERVAL_MS = 7 * 24 * 3600 * 1000; // 7 days
const CONSECUTIVE_DRIFTS_TO_PAUSE = 3;
/** Minimum settled bets before drift detection can fire — below this, even a
 * real-but-small effect can't be distinguished from noise. */
const MIN_BETS_FOR_DRIFT = 50;

interface SettledAggRow {
  n_settled: number;
  total_stake: number | null;
  total_pnl: number | null;
}

const ulidLike = (): string => {
  const ts = Date.now().toString(36).padStart(10, "0");
  const rand = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36),
  ).join("");
  return `${ts}${rand}`.toUpperCase();
};

async function lastValidationFor(strategyId: string): Promise<{
  ranAt: Date | null;
  consecutive: number;
}> {
  const result = await db.execute(
    sql`SELECT ran_at, consecutive_drifts
        FROM strategy_validations
        WHERE strategy_id = ${strategyId}
        ORDER BY ran_at DESC
        LIMIT 1`,
  );
  const row = result.rows[0] as
    | { ran_at: string | Date; consecutive_drifts: number }
    | undefined;
  if (!row) return { ranAt: null, consecutive: 0 };
  return {
    ranAt: new Date(row.ran_at as string),
    consecutive: Number(row.consecutive_drifts ?? 0),
  };
}

async function aggregateSettled(strategyId: string): Promise<SettledAggRow> {
  const result = await db.execute(
    sql`SELECT
          COUNT(*) FILTER (WHERE outcome IN ('won','half_won','lost','half_lost','void'))::int  AS n_settled,
          COALESCE(SUM(stake) FILTER (WHERE placed_at IS NOT NULL), 0)::float                   AS total_stake,
          COALESCE(SUM(pnl)   FILTER (WHERE placed_at IS NOT NULL), 0)::float                   AS total_pnl
        FROM bets WHERE strategy_id = ${strategyId}`,
  );
  return (
    (result.rows[0] as unknown as SettledAggRow | undefined) ?? {
      n_settled: 0,
      total_stake: 0,
      total_pnl: 0,
    }
  );
}

/**
 * Runs one validation pass over all live strategies. Idempotent — if a
 * strategy was already validated within the last `CHECK_INTERVAL_MS`, it's
 * skipped this tick.
 *
 * Returns a small summary so the scheduler can log progress.
 */
export async function runAutoValidation(): Promise<{
  scanned: number;
  validated: number;
  paused: number;
  skipped: number;
}> {
  const all = await listStrategies();
  const live = all.filter((s) => s.status === "live");
  const now = new Date();
  let validated = 0;
  let paused = 0;
  let skipped = 0;

  for (const strat of live) {
    try {
      const last = await lastValidationFor(strat.id);
      if (
        last.ranAt &&
        now.getTime() - last.ranAt.getTime() < CHECK_INTERVAL_MS
      ) {
        skipped += 1;
        continue;
      }

      const snap = (strat.metricsSnapshot as Record<string, unknown>) ?? {};
      const oosRoi =
        typeof snap.oosRoiMean === "number" ? snap.oosRoiMean : null;
      const oosLow =
        typeof snap.oosRoiCiLow === "number" ? snap.oosRoiCiLow : null;
      const oosHigh =
        typeof snap.oosRoiCiHigh === "number" ? snap.oosRoiCiHigh : null;

      const agg = await aggregateSettled(strat.id);
      const liveRoi =
        agg.total_stake && agg.total_stake > 0
          ? ((agg.total_pnl ?? 0) / agg.total_stake) * 100
          : null;

      // Drift only fires once we have enough bets to be statistically meaningful.
      let drift = false;
      let nextConsecutive = 0;
      if (
        agg.n_settled >= MIN_BETS_FOR_DRIFT &&
        liveRoi !== null &&
        oosLow !== null &&
        oosHigh !== null
      ) {
        drift = liveRoi < oosLow || liveRoi > oosHigh;
        nextConsecutive = drift ? last.consecutive + 1 : 0;
      } else {
        nextConsecutive = last.consecutive; // hold steady — not enough data
      }

      // Should we auto-pause?
      let triggered = false;
      let note: string | null = null;
      if (drift && nextConsecutive >= CONSECUTIVE_DRIFTS_TO_PAUSE) {
        triggered = true;
        note = `Auto-paused after ${nextConsecutive} consecutive drift checks (live ROI ${liveRoi?.toFixed(2)}% outside OOS CI [${oosLow?.toFixed(2)}, ${oosHigh?.toFixed(2)}]).`;
        await setStrategyStatus(strat.id, "paused");
        invalidateLiveStrategiesCache();
        paused += 1;
        logger.warn(tag, `Strategy ${strat.id} (${strat.name}): ${note}`);
      }

      await db.execute(
        sql`INSERT INTO strategy_validations (
              id, strategy_id, n_settled, live_roi_pct,
              snapshot_roi_mean, snapshot_roi_ci_low, snapshot_roi_ci_high,
              drift_flag, consecutive_drifts, triggered_auto_pause, note
            ) VALUES (
              ${ulidLike()}, ${strat.id}, ${agg.n_settled}, ${liveRoi},
              ${oosRoi}, ${oosLow}, ${oosHigh},
              ${drift}, ${nextConsecutive}, ${triggered}, ${note}
            )`,
      );
      validated += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(tag, `Strategy ${strat.id} validation failed: ${msg}`);
    }
  }

  if (validated > 0 || paused > 0) {
    logger.info(
      tag,
      `Scan complete: ${live.length} live · ${validated} validated · ${paused} auto-paused · ${skipped} skipped (within window)`,
    );
  }
  return { scanned: live.length, validated, paused, skipped };
}

/** History rows for a single strategy — UI for the Strategies tab detail. */
export async function listValidationsForStrategy(
  strategyId: string,
  limit = 50,
): Promise<
  Array<{
    id: string;
    ranAt: string;
    nSettled: number;
    liveRoiPct: number | null;
    snapshotRoiMean: number | null;
    snapshotRoiCiLow: number | null;
    snapshotRoiCiHigh: number | null;
    driftFlag: boolean;
    consecutiveDrifts: number;
    triggeredAutoPause: boolean;
    note: string | null;
  }>
> {
  const result = await db.execute(
    sql`SELECT id, ran_at AS "ranAt", n_settled AS "nSettled",
               live_roi_pct AS "liveRoiPct",
               snapshot_roi_mean AS "snapshotRoiMean",
               snapshot_roi_ci_low AS "snapshotRoiCiLow",
               snapshot_roi_ci_high AS "snapshotRoiCiHigh",
               drift_flag AS "driftFlag",
               consecutive_drifts AS "consecutiveDrifts",
               triggered_auto_pause AS "triggeredAutoPause",
               note
        FROM strategy_validations
        WHERE strategy_id = ${strategyId}
        ORDER BY ran_at DESC
        LIMIT ${limit}`,
  );
  return result.rows as never;
}
