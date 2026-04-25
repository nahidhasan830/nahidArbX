/**
 * One-shot: mark a hung optimizer run as failed.
 *
 * Use when the Cloud Run instance died mid-sweep and left a row stuck in
 * status='running' forever. Connects through whatever DATABASE_URL points
 * at (Cloud SQL proxy on localhost or direct connector).
 *
 * Usage:
 *   RUN_ID=00MOD... npx tsx scripts/mark-stuck-run-failed.ts
 */
import "dotenv/config";
import { Pool } from "pg";

const RUN_ID = process.env.RUN_ID;
if (!RUN_ID) throw new Error("RUN_ID env var required");

const ERROR_MSG =
  process.env.ERROR_MSG ??
  "Cloud Run instance reaped by autoscaler ~15 min after /run/start returned 202 " +
    "(last trial inserted 2026-04-25T01:15:48Z, run row never updated). " +
    "3,160 trials persisted but no Pareto/PBO/WRC summary computed. " +
    "Root cause: --no-cpu-throttling keeps CPU allocated only while the instance is alive; " +
    "it does not prevent scale-to-zero when no requests are in flight. " +
    "Fix in flight: --min-instances=1 or migrate to Cloud Run Jobs.";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const res = await pool.query(
      `UPDATE optimization_runs
       SET status = 'failed', error = $1, completed_at = NOW()
       WHERE id = $2 AND status = 'running'
       RETURNING id, status, n_trials_done, completed_at`,
      [ERROR_MSG, RUN_ID],
    );
    console.log("rows updated:", res.rowCount);
    console.log(res.rows[0] ?? "(no row matched — already not running?)");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
