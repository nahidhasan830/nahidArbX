/**
 * End-to-end verification for the optimizer:run_completed Telegram ping.
 *
 * Uses the raw pg Pool (same pattern as apply-one-migration.ts) so it
 * doesn't depend on lib/db/client.ts top-level await. Inserts a
 * synthetic completed run + best-trial row, then builds the event and
 * calls notify() directly — exercising the full notifier pipeline
 * without requiring the Python sidecar or a dev-server restart.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/test-optimizer-telegram.ts
 */
import "dotenv/config";
import { Pool, type PoolClient } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { notify } from "../lib/notifier";
import type { OptimizerRunCompletedEvent } from "../lib/notifier/types";

async function buildPool(): Promise<Pool> {
  const cs = process.env.DATABASE_URL!;
  const instance = process.env.CLOUD_SQL_INSTANCE;
  if (!instance) return new Pool({ connectionString: cs, max: 1 });
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

const ulidLike = (): string => {
  const ts = Date.now().toString(36).padStart(10, "0");
  const rand = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36),
  ).join("");
  return `${ts}${rand}`.toUpperCase();
};

async function insertSyntheticRun(
  client: PoolClient,
  runId: string,
  trialId: string,
): Promise<void> {
  const now = new Date();
  const startedAt = new Date(now.getTime() - 14 * 60_000 - 32_000); // 14m 32s ago

  await client.query(
    `INSERT INTO optimization_runs
      (id, name, status, search_space, search_algorithm, n_trials_target,
       n_trials_done, rng_seed, cv_strategy, data_filters, summary,
       best_trial_id, started_at, completed_at, notify_on_complete,
       notified_at, created_by)
     VALUES
      ($1, $2, 'completed', $3::jsonb, 'ensemble', 2000,
       2000, 42, $4::jsonb, $5::jsonb, $6::jsonb,
       $7, $8, $9, true,
       NULL, 'manual')`,
    [
      runId,
      `Test Notification ${now.toISOString().slice(11, 16)}`,
      JSON.stringify({ dimensions: [] }),
      JSON.stringify({
        type: "cpcv",
        n_groups: 10,
        n_test_groups: 2,
        embargo_pct: 0.01,
      }),
      JSON.stringify({}),
      JSON.stringify({
        n_trials_completed: 2000,
        n_pareto: 7,
        best_composite_score: 1.42,
        best_trial_id: trialId,
        cpcv: { n_groups: 10, n_test_groups: 2, n_paths: 45 },
        completed_at_utc: now.toISOString(),
      }),
      trialId,
      startedAt.toISOString(),
      now.toISOString(),
    ],
  );

  await client.query(
    `INSERT INTO optimization_trials
      (id, run_id, trial_index, sampler, params, fold_metrics,
       oos_roi_mean, oos_roi_ci_low, oos_roi_ci_high,
       oos_sortino, oos_sharpe, deflated_sharpe, probabilistic_sharpe,
       max_drawdown, sample_size, composite_score, on_pareto)
     VALUES
      ($1, $2, 42, 'tpe', $3::jsonb, '[]'::jsonb,
       4.21, 2.18, 6.24,
       1.91, 1.38, 0.82, 0.91,
       6.8, 512, 1.42, true)`,
    [
      trialId,
      runId,
      JSON.stringify({
        min_ev_pct: 2.5,
        max_odds_age_sec: 60,
        kelly_fraction: 0.25,
        kelly_cap_pct: 10,
      }),
    ],
  );
}

function buildEvent(
  runId: string,
  trialId: string,
  name: string,
): OptimizerRunCompletedEvent {
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  return {
    type: "optimizer:run_completed",
    at: new Date().toISOString(),
    runId,
    name,
    status: "completed",
    searchAlgorithm: "ensemble",
    startedAt: new Date(Date.now() - 14 * 60_000 - 32_000).toISOString(),
    completedAt: new Date().toISOString(),
    durationSec: 872,
    nTrialsDone: 2000,
    nTrialsTarget: 2000,
    nPareto: 7,
    bestComposite: 1.42,
    best: {
      trialId,
      trialIndex: 42,
      roiPct: 4.21,
      roiCiLow: 2.18,
      roiCiHigh: 6.24,
      sharpe: 1.38,
      sortino: 1.91,
      maxDrawdownPct: 6.8,
      deflatedSharpe: 0.82,
      probabilisticSharpe: 0.91,
      sampleSize: 512,
    },
    createdBy: "manual",
    error: null,
    dashboardUrl: baseUrl ? `${baseUrl}/lab/alphasearch/${runId}` : undefined,
    topTrialUrl: baseUrl
      ? `${baseUrl}/lab/alphasearch/${runId}#trial=42`
      : undefined,
  };
}

async function main() {
  const hasCreds =
    Boolean(process.env.TELEGRAM_BOT_TOKEN) &&
    Boolean(process.env.TELEGRAM_CHAT_ID);
  console.log(
    `Telegram creds: ${hasCreds ? "present" : "MISSING — ping will be a no-op"}`,
  );
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");

  const runId = ulidLike();
  const trialId = ulidLike();
  const name = `Test Notification ${new Date().toISOString().slice(11, 16)}`;

  const pool = await buildPool();
  const client = await pool.connect();
  try {
    console.log(`\nInserting run ${runId} + trial ${trialId} …`);
    await insertSyntheticRun(client, runId, trialId);

    console.log("Stamping notified_at (simulating notifier tick claim) …");
    await client.query(
      `UPDATE optimization_runs SET notified_at = now() WHERE id = $1`,
      [runId],
    );

    console.log("Dispatching optimizer:run_completed event …");
    const event = buildEvent(runId, trialId, name);
    await notify(event);
    console.log("notify() returned (channels fan-out resolved).");

    console.log(
      "\n✅ Telegram notification path exercised end-to-end. Check your chat.",
    );
    console.log(
      `   The synthetic run is viewable at ${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/lab/alphasearch/${runId}`,
    );
  } finally {
    client.release();
    await pool.end();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
