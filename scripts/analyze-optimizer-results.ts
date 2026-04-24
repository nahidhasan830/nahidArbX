/**
 * Pulls every completed optimizer run from prod + the top trials per run
 * and prints a human-readable quality report. Answers:
 *
 *   - Are the winning configs "real" (DSR > 0.95, PSR > 0.95, CI floor > 0)?
 *   - Or is PBO / WRC telling us we're fitting noise?
 *   - How do top trials differ from the median?
 *
 * Uses the raw pg.Pool + Cloud SQL connector.
 */
import "dotenv/config";
import { Pool } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";

interface RunSummary {
  id: string;
  name: string;
  status: string;
  n_trials_done: number;
  n_trials_target: number;
  completed_at: string | null;
  started_at: string | null;
  summary: Record<string, unknown> | null;
  best_trial_id: string | null;
}

interface TrialRow {
  id: string;
  trial_index: number;
  sampler: string;
  oos_roi_mean: number | null;
  oos_roi_ci_low: number | null;
  oos_roi_ci_high: number | null;
  oos_sharpe: number | null;
  oos_sortino: number | null;
  deflated_sharpe: number | null;
  probabilistic_sharpe: number | null;
  max_drawdown: number | null;
  sample_size: number | null;
  composite_score: number | null;
  on_pareto: boolean;
  params: Record<string, unknown>;
}

const fmt = (n: number | null | undefined, dp = 3): string =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(dp) : "—";

const pct = (n: number | null | undefined, dp = 2): string =>
  typeof n === "number" && Number.isFinite(n)
    ? `${n >= 0 ? "+" : ""}${n.toFixed(dp)}%`
    : "—";

function verdictPBO(pbo: number): string {
  if (pbo < 0.05) return "✅ low overfit";
  if (pbo < 0.2) return "🟡 borderline";
  if (pbo < 0.4) return "🟠 concerning";
  return "🔴 search too aggressive for this data";
}

function verdictWRC(wrc: number): string {
  if (wrc < 0.05) return "✅ significant vs baseline";
  if (wrc < 0.2) return "🟡 weak evidence";
  return "🔴 indistinguishable from luck";
}

function verdictDSR(dsr: number): string {
  if (dsr >= 0.95) return "✅ real";
  if (dsr >= 0.8) return "🟡 probably real";
  if (dsr >= 0.5) return "🟠 weak";
  return "🔴 luck-driven";
}

function verdictCI(low: number | null | undefined): string {
  if (typeof low !== "number") return "—";
  if (low > 1) return "✅ CI > +1%";
  if (low > 0) return "🟡 CI just above 0";
  return "🔴 CI crosses 0";
}

async function buildPool(): Promise<Pool> {
  const cs = process.env.DATABASE_URL!;
  const instance = process.env.CLOUD_SQL_INSTANCE!;
  const url = new URL(cs);
  const c = new Connector();
  const opts = await c.getOptions({
    instanceConnectionName: instance,
    ipType: IpAddressTypes.PUBLIC,
  });
  return new Pool({
    ...opts,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    max: 1,
  });
}

async function main() {
  const pool = await buildPool();
  const runs = await pool.query<RunSummary>(`
    SELECT id, name, status, n_trials_done, n_trials_target,
           completed_at, started_at, summary, best_trial_id
    FROM optimization_runs
    WHERE status = 'completed'
    ORDER BY completed_at DESC
    LIMIT 10`);

  if (runs.rows.length === 0) {
    console.log("No completed runs yet.");
    await pool.end();
    return;
  }

  console.log(`\n${"═".repeat(92)}`);
  console.log(
    `  AlphaSearch results report — ${runs.rows.length} completed run(s)`,
  );
  console.log(`${"═".repeat(92)}\n`);

  for (const run of runs.rows) {
    const durationSec =
      run.started_at && run.completed_at
        ? Math.round(
            (new Date(run.completed_at).getTime() -
              new Date(run.started_at).getTime()) /
              1000,
          )
        : null;

    console.log(
      `── ${run.name} ${"─".repeat(Math.max(0, 60 - run.name.length))}`,
    );
    console.log(`   id:        ${run.id}`);
    console.log(
      `   trials:    ${run.n_trials_done}/${run.n_trials_target} · duration ${durationSec ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s` : "—"}`,
    );

    const s = run.summary ?? {};
    const pbo = typeof s.pbo === "number" ? s.pbo : null;
    const wrc = typeof s.wrc_pvalue === "number" ? s.wrc_pvalue : null;
    const nPareto = typeof s.n_pareto === "number" ? s.n_pareto : null;
    const bestComposite =
      typeof s.best_composite_score === "number"
        ? s.best_composite_score
        : null;
    const cv = (s.cv ?? {}) as { type?: string; n_paths?: number };

    console.log(
      `   CV:        ${cv.type ?? "—"} · ${cv.n_paths ?? "—"} OOS paths`,
    );
    if (bestComposite !== null)
      console.log(`   Best composite score: ${fmt(bestComposite)}`);
    if (nPareto !== null) console.log(`   Pareto frontier size: ${nPareto}`);
    if (pbo !== null)
      console.log(
        `   PBO:       ${(pbo * 100).toFixed(1)}%  ${verdictPBO(pbo)}`,
      );
    if (wrc !== null)
      console.log(`   WRC p:     ${fmt(wrc, 4)}  ${verdictWRC(wrc)}`);
    console.log();

    // Top trials
    const trialsRes = await pool.query<TrialRow>(
      `SELECT id, trial_index, sampler,
              oos_roi_mean::float8 AS oos_roi_mean,
              oos_roi_ci_low::float8 AS oos_roi_ci_low,
              oos_roi_ci_high::float8 AS oos_roi_ci_high,
              oos_sharpe::float8 AS oos_sharpe,
              oos_sortino::float8 AS oos_sortino,
              deflated_sharpe::float8 AS deflated_sharpe,
              probabilistic_sharpe::float8 AS probabilistic_sharpe,
              max_drawdown::float8 AS max_drawdown,
              sample_size,
              composite_score::float8 AS composite_score,
              on_pareto, params
         FROM optimization_trials
         WHERE run_id = $1
         ORDER BY composite_score DESC NULLS LAST
         LIMIT 10`,
      [run.id],
    );

    if (trialsRes.rows.length === 0) {
      console.log("   (no trials persisted)\n");
      continue;
    }

    console.log("   Top trials by composite:");
    console.log(
      "   " +
        "idx".padStart(4) +
        " " +
        "comp".padStart(7) +
        " " +
        "Sharpe".padStart(7) +
        " " +
        "Sortino".padStart(8) +
        " " +
        "ROI%".padStart(8) +
        " " +
        "CI-low".padStart(9) +
        " " +
        "CI-hi".padStart(9) +
        " " +
        "DSR".padStart(6) +
        " " +
        "PSR".padStart(6) +
        " " +
        "MaxDD".padStart(7) +
        " " +
        "n".padStart(6) +
        "  Verdict",
    );
    for (const t of trialsRes.rows) {
      const line =
        "   " +
        String(t.trial_index).padStart(4) +
        " " +
        fmt(t.composite_score, 3).padStart(7) +
        " " +
        fmt(t.oos_sharpe).padStart(7) +
        " " +
        fmt(t.oos_sortino).padStart(8) +
        " " +
        pct(t.oos_roi_mean).padStart(8) +
        " " +
        pct(t.oos_roi_ci_low).padStart(9) +
        " " +
        pct(t.oos_roi_ci_high).padStart(9) +
        " " +
        fmt(t.deflated_sharpe, 2).padStart(6) +
        " " +
        fmt(t.probabilistic_sharpe, 2).padStart(6) +
        " " +
        pct(t.max_drawdown, 1).padStart(7) +
        " " +
        String(t.sample_size ?? "—").padStart(6) +
        "  " +
        [
          t.deflated_sharpe != null ? verdictDSR(t.deflated_sharpe) : "",
          verdictCI(t.oos_roi_ci_low),
          t.on_pareto ? "⭐ Pareto" : "",
        ]
          .filter(Boolean)
          .join(" · ");
      console.log(line);
    }

    // Distribution stats
    const comp = trialsRes.rows
      .map((t) => t.composite_score)
      .filter((x): x is number => typeof x === "number");
    if (comp.length > 1) {
      const sorted = comp.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const best = sorted[sorted.length - 1];
      const worst = sorted[0];
      const separation =
        median !== 0 ? best / median : Number.POSITIVE_INFINITY;
      console.log(
        `\n   Top-10 distribution: best ${fmt(best)} · median ${fmt(median)} · worst ${fmt(worst)} · best/median = ${fmt(separation, 2)}×`,
      );
    }

    // Top-trial params
    const winner = trialsRes.rows[0];
    if (winner) {
      console.log("\n   Winner config:");
      const paramLines = Object.entries(winner.params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `     ${k.padEnd(22)} = ${JSON.stringify(v)}`);
      for (const l of paramLines) console.log(l);
    }
    console.log();
  }

  // Overall observations
  console.log(`${"═".repeat(92)}`);
  console.log("  Quick take");
  console.log(`${"═".repeat(92)}`);
  const anyGoodRun = runs.rows.some((r) => {
    const s = r.summary ?? {};
    return (
      typeof s.pbo === "number" &&
      s.pbo < 0.1 &&
      typeof s.wrc_pvalue === "number" &&
      s.wrc_pvalue < 0.1
    );
  });
  if (anyGoodRun) {
    console.log(
      "  At least one completed run shows low PBO and a WRC p-value that beats the baseline.",
    );
  } else {
    console.log(
      "  No run so far clears both PBO < 10% AND WRC p < 0.1 thresholds.",
    );
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
