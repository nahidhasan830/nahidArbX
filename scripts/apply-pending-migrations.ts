/**
 * One-shot runner for Optimisation migrations against the production
 * Cloud SQL instance. Every migration file is idempotent
 * (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), so it's
 * safe to re-run — only the pending DDL executes.
 *
 * Why this script exists: Drizzle's `db.select().from(table)` expands
 * to a SELECT that names every schema column. When we add a new column
 * in the schema, Postgres rejects the whole statement until the
 * matching migration lands — and any endpoint doing a row-level read
 * returns 500.
 *
 * Connection path mirrors `lib/db/client.ts` exactly:
 *   - If `CLOUD_SQL_INSTANCE` is set, use the @google-cloud/cloud-sql-connector
 *     with IAM ADC (no proxy needed; same path the app uses in prod).
 *   - Otherwise, fall back to the raw DATABASE_URL string (local dev
 *     with a proxy, if anyone's still running one).
 *
 * Usage:
 *   npx tsx scripts/apply-pending-migrations.ts
 *   npx tsx scripts/apply-pending-migrations.ts 0025   # apply just one
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool, type PoolConfig } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import "dotenv/config";

// Keep this list in order. Idempotent DDL means re-running a past
// migration is a no-op, so we don't track which ones already ran.
const MIGRATIONS = [
  "0018_alphasearch_optimizer.sql",
  "0019_optimization_data_filters.sql",
  "0020_optimization_schedules.sql",
  "0021_alphasearch_strategies.sql",
  "0022_strategy_validations.sql",
  "0023_optimizer_run_notifications.sql",
  "0024_widen_optimizer_metric_columns.sql",
  "0025_optimizer_run_started_notified_at.sql",
  "0026_optimizer_run_notify_on_start.sql",
];

async function buildPool(): Promise<Pool> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set — check .env");

  const instance = process.env.CLOUD_SQL_INSTANCE;
  if (!instance) {
    console.log("[migrate] no CLOUD_SQL_INSTANCE — using plain DATABASE_URL");
    return new Pool({ connectionString: url, max: 4 });
  }

  console.log(`[migrate] connecting via Cloud SQL connector → ${instance}`);
  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const database = parsed.pathname.slice(1);

  const connector = new Connector();
  const opts = await connector.getOptions({
    instanceConnectionName: instance,
    ipType: IpAddressTypes.PUBLIC,
  });
  const cfg: PoolConfig = { ...opts, user, password, database, max: 4 };
  return new Pool(cfg);
}

async function main() {
  const onlyArg = process.argv[2];
  const selection = onlyArg
    ? MIGRATIONS.filter((m) => m.startsWith(onlyArg))
    : MIGRATIONS;

  if (onlyArg && selection.length === 0) {
    console.error(
      `No migration matches "${onlyArg}". Known: ${MIGRATIONS.join(", ")}`,
    );
    process.exit(1);
  }

  const pool = await buildPool();

  for (const file of selection) {
    const path = join(process.cwd(), "lib/db/migrations", file);
    const body = readFileSync(path, "utf8");
    process.stdout.write(`→ ${file} … `);
    try {
      await pool.query(body);
      process.stdout.write("ok\n");
    } catch (err) {
      process.stdout.write("FAILED\n");
      throw err;
    }
  }

  // Post-checks — these are the columns/tables that matter for current
  // Drizzle schema coverage. If any of them are missing, the app will
  // 500 on corresponding reads.
  console.log("\nSchema post-checks:");
  const checks: Array<{ what: string; sql: string; expect: number }> = [
    {
      what: "bets.strategy_id",
      sql: `SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_name = 'bets' AND column_name = 'strategy_id'`,
      expect: 1,
    },
    {
      what: "optimization_runs.notified_at",
      sql: `SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_name = 'optimization_runs' AND column_name = 'notified_at'`,
      expect: 1,
    },
    {
      what: "optimization_runs.started_notified_at",
      sql: `SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_name = 'optimization_runs' AND column_name = 'started_notified_at'`,
      expect: 1,
    },
    {
      what: "optimization_runs.notify_on_start",
      sql: `SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_name = 'optimization_runs' AND column_name = 'notify_on_start'`,
      expect: 1,
    },
    {
      what: "optimization_schedules.notify_on_start",
      sql: `SELECT count(*)::int AS n FROM information_schema.columns
              WHERE table_name = 'optimization_schedules' AND column_name = 'notify_on_start'`,
      expect: 1,
    },
    {
      what: "strategy_validations table",
      sql: `SELECT count(*)::int AS n FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = 'strategy_validations'`,
      expect: 1,
    },
  ];
  let failures = 0;
  for (const c of checks) {
    const r = await pool.query<{ n: number }>(c.sql);
    const n = r.rows[0]?.n ?? 0;
    const mark = n === c.expect ? "✓" : "✗";
    if (n !== c.expect) failures += 1;
    console.log(`  ${mark} ${c.what} (found ${n}, expected ${c.expect})`);
  }

  await pool.end();
  if (failures > 0) {
    console.error(`\n${failures} post-check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll migrations applied. Schema is in sync with Drizzle.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
