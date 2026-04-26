/**
 * Wipes every row from `optimization_runs`. Trials cascade via FK
 * (`optimization_trials.run_id ON DELETE CASCADE`, see schema.ts:438).
 *
 * Schedules and strategies are untouched — they outlive their source
 * runs by design.
 *
 * Safety:
 *   - First flips any in-flight rows to status='cancelled' so a running
 *     Cloud Run Job execution exits cleanly (its `_cancel_watcher` polls
 *     the flag every 2s) before we DELETE the parent row.
 *   - Prints a preview and exits without `CONFIRM=1`. Only with
 *     `CONFIRM=1` set does it actually DELETE.
 *
 * Usage:
 *   npx tsx scripts/wipe-optimizer-runs.ts            # preview only
 *   CONFIRM=1 npx tsx scripts/wipe-optimizer-runs.ts  # actually wipe
 */
import "dotenv/config";
import { Pool, type PoolConfig } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";

async function buildPool(): Promise<Pool> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set — check .env");

  const instance = process.env.CLOUD_SQL_INSTANCE;
  if (!instance) {
    console.log("[wipe] no CLOUD_SQL_INSTANCE — using plain DATABASE_URL");
    return new Pool({ connectionString: url, max: 2 });
  }

  console.log(`[wipe] connecting via Cloud SQL connector → ${instance}`);
  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const database = parsed.pathname.slice(1);

  const connector = new Connector();
  const opts = await connector.getOptions({
    instanceConnectionName: instance,
    ipType: IpAddressTypes.PUBLIC,
  });
  const cfg: PoolConfig = { ...opts, user, password, database, max: 2 };
  return new Pool(cfg);
}

async function drainActiveRuns(pool: Pool): Promise<void> {
  // DB-driven drain — works whether the sidecar is the legacy Service or
  // the current Cloud Run Job. We flip status='cancelled' on any in-flight
  // rows; the running Job's `_cancel_watcher` polls the flag every 2s and
  // exits cleanly within one trial-time. After a 30s grace window we
  // proceed regardless (the FK cascade on DELETE handles any stragglers
  // — they'll fail on the trial INSERT with FK violation, log, and exit).
  const flipped = await pool.query<{ id: string }>(
    `UPDATE optimization_runs
     SET status = 'cancelled'
     WHERE status IN ('queued', 'running')
     RETURNING id`,
  );
  if (flipped.rowCount === 0) {
    console.log("[wipe] no active/queued runs — good");
    return;
  }
  console.log(
    `[wipe] cancelled ${flipped.rowCount} active run(s): ${flipped.rows.map((r) => r.id).join(", ")}`,
  );
  console.log(
    "[wipe] waiting 30s for any running Job executions to exit cleanly…",
  );
  await new Promise((r) => setTimeout(r, 30_000));
}

async function printPreview(pool: Pool): Promise<void> {
  const runs = await pool.query<{
    runs_total: string;
    in_flight: string;
    completed: string;
    failed: string;
    cancelled: string;
  }>(`
    SELECT COUNT(*)::text AS runs_total,
           COUNT(*) FILTER (WHERE status IN ('queued','running'))::text AS in_flight,
           COUNT(*) FILTER (WHERE status = 'completed')::text AS completed,
           COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
           COUNT(*) FILTER (WHERE status = 'cancelled')::text AS cancelled
    FROM optimization_runs
  `);
  const r = runs.rows[0];
  const trials = await pool.query<{ trials_total: string }>(
    `SELECT COUNT(*)::text AS trials_total FROM optimization_trials`,
  );
  console.log("\n── Current state ──────────────────────────────");
  console.log(`  optimization_runs:    ${r.runs_total}`);
  console.log(`    queued/running:     ${r.in_flight}`);
  console.log(`    completed:          ${r.completed}`);
  console.log(`    failed:             ${r.failed}`);
  console.log(`    cancelled:          ${r.cancelled}`);
  console.log(`  optimization_trials:  ${trials.rows[0].trials_total}`);
  console.log("───────────────────────────────────────────────\n");
}

async function main() {
  const confirm = process.env.CONFIRM === "1";
  console.log(
    confirm
      ? "[wipe] CONFIRM=1 — will DELETE all optimization runs + trials."
      : "[wipe] preview mode — set CONFIRM=1 to actually delete.",
  );

  const pool = await buildPool();
  try {
    await drainActiveRuns(pool);
    await printPreview(pool);

    if (!confirm) {
      console.log("[wipe] preview complete. Re-run with CONFIRM=1 to delete.");
      return;
    }

    console.log(
      "[wipe] deleting all rows from optimization_runs (cascades to trials)…",
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const del = await client.query("DELETE FROM optimization_runs");
      await client.query("COMMIT");
      console.log(
        `[wipe] deleted ${del.rowCount ?? 0} run rows (+ cascaded trials).`,
      );
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    console.log("\n── Post-wipe state ────────────────────────────");
    await printPreview(pool);
    console.log("[wipe] done.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[wipe] failed:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
