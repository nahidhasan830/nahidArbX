#!/usr/bin/env npx tsx
import "dotenv/config";

import { ensureDbReady, db } from "../lib/db/client";
import { sql } from "drizzle-orm";

type BacktestRow = {
  policy: string;
  sample_size: number | string;
  roi_pct: number | string | null;
  avg_clv_pct: number | string | null;
  remaining_conflict_families: number | string;
  rows_from_original_conflicts: number | string;
};

function fmt(value: unknown, digits = 2): string {
  if (value == null) return "-";
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "-";
}

async function main(): Promise<void> {
  await ensureDbReady();

  const result = await db.execute(sql`
    WITH latest_deployed AS (
      SELECT
        COALESCE(
          NULLIF(training_report->>'policy_edge_threshold_pct', '')::double precision,
          2.0
        ) AS threshold_pct
      FROM ml_models
      WHERE status = 'deployed'
      ORDER BY deployed_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    ),
    scored AS (
      SELECT
        a.bet_id,
        a.event_id,
        a.family_id,
        a.atom_id,
        a.market_type,
        a.ml_score::double precision AS ml_score,
        a.model_edge_pct::double precision AS model_edge_pct,
        a.baseline_ev_pct::double precision AS baseline_ev_pct,
        a.outcome,
        a.clv_pct::double precision AS clv_pct,
        a.soft_odds::double precision AS soft_odds,
        a.soft_commission_pct::double precision AS comm_pct,
        COALESCE((SELECT threshold_pct FROM latest_deployed), 2.0) AS threshold_pct
      FROM ml_prediction_audit a
      WHERE a.ml_score IS NOT NULL
        AND a.outcome NOT IN ('pending', 'void')
    ),
    returns AS (
      SELECT *,
        CASE
          WHEN outcome = 'won' THEN (soft_odds - 1) * (1 - comm_pct / 100.0)
          WHEN outcome = 'half_won' THEN (soft_odds - 1) * (1 - comm_pct / 100.0) * 0.5
          WHEN outcome = 'half_lost' THEN -0.5
          ELSE -1.0
        END AS unit_return
      FROM scored
    ),
    simple_core AS (
      SELECT *
      FROM returns
      WHERE baseline_ev_pct >= 3.0
        AND market_type IN ('MATCH_RESULT', 'ASIAN_HANDICAP')
    ),
    ml_gate AS (
      SELECT *
      FROM simple_core
      WHERE model_edge_pct > threshold_pct
    ),
    ranked AS (
      SELECT *,
        row_number() OVER (
          PARTITION BY event_id, family_id
          ORDER BY model_edge_pct DESC, ml_score DESC, baseline_ev_pct DESC, bet_id ASC
        ) AS family_rank,
        count(*) OVER (PARTITION BY event_id, family_id) AS family_selected_count
      FROM ml_gate
    ),
    policies AS (
      SELECT
        'simple_core' AS policy,
        event_id,
        family_id,
        unit_return,
        clv_pct,
        1 AS family_rank,
        1 AS family_selected_count
      FROM simple_core
      UNION ALL
      SELECT
        'ml_gate',
        event_id,
        family_id,
        unit_return,
        clv_pct,
        family_rank,
        family_selected_count
      FROM ranked
      UNION ALL
      SELECT
        'ml_gate_best_per_family',
        event_id,
        family_id,
        unit_return,
        clv_pct,
        family_rank,
        family_selected_count
      FROM ranked
      WHERE family_rank = 1
    )
    SELECT
      policy,
      count(*)::int AS sample_size,
      round((avg(unit_return) * 100.0)::numeric, 4) AS roi_pct,
      round((avg(clv_pct) FILTER (WHERE clv_pct IS NOT NULL))::numeric, 4) AS avg_clv_pct,
      count(DISTINCT event_id || '|' || family_id) FILTER (
        WHERE policy = 'ml_gate' AND family_selected_count > 1
      )::int AS remaining_conflict_families,
      count(*) FILTER (WHERE family_selected_count > 1)::int AS rows_from_original_conflicts
    FROM policies
    GROUP BY policy
    ORDER BY CASE policy
      WHEN 'simple_core' THEN 1
      WHEN 'ml_gate' THEN 2
      WHEN 'ml_gate_best_per_family' THEN 3
      ELSE 4
    END
  `);

  const rows = result.rows as BacktestRow[];
  console.log("ML policy backtest on settled prediction audit rows");
  console.log(
    "policy                     n      ROI%     CLV%   live conflicts  rows from conflicts",
  );
  for (const row of rows) {
    console.log(
      `${row.policy.padEnd(26)} ${String(row.sample_size).padStart(5)} ${fmt(row.roi_pct, 2).padStart(8)} ${fmt(row.avg_clv_pct, 2).padStart(8)} ${String(row.remaining_conflict_families).padStart(16)} ${String(row.rows_from_original_conflicts).padStart(20)}`,
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
