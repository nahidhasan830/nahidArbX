/**
 * One-shot runner for the AlphaSearch (Phase 1-5) migrations.
 *
 * Each .sql file is idempotent (CREATE TABLE IF NOT EXISTS, ADD COLUMN
 * IF NOT EXISTS). Safe to re-run.
 *
 * Migration 0021 adds `bets.strategy_id` — until that column exists in
 * the deployed DB, drizzle's `db.select().from(bets)` expands to a SELECT
 * that names every schema column, so Postgres rejects the whole statement
 * and any endpoint doing a row-level read of bets returns 500.
 *
 * Uses a standalone pg Pool (avoids importing the app's client.ts which
 * relies on top-level await incompatible with tsx/CJS). Same DATABASE_URL
 * the app uses.
 *
 * Usage:  cloud-sql-proxy --port 5432 nahidarbx-6e73:asia-south1:nahidarbx-db &
 *         npx tsx scripts/apply-pending-migrations.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import "dotenv/config";

const MIGRATIONS = [
  "0018_alphasearch_optimizer.sql",
  "0019_optimization_data_filters.sql",
  "0020_optimization_schedules.sql",
  "0021_alphasearch_strategies.sql",
  "0022_strategy_validations.sql",
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: url });

  for (const file of MIGRATIONS) {
    const path = join(process.cwd(), "lib/db/migrations", file);
    const body = readFileSync(path, "utf8");
    console.log(`\n→ ${file}`);
    await pool.query(body);
    console.log(`  ok`);
  }

  // Single post-check that proves the column-level fix landed: this is the
  // change that unblocks /api/accounts/stats, /api/bets, /api/bets/placed.
  const col = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM information_schema.columns
       WHERE table_name = 'bets' AND column_name = 'strategy_id'`,
  );
  console.log(
    `\nbets.strategy_id column present: ${col.rows[0].n === 1 ? "✓" : "✗"}`,
  );

  // Bonus visibility: confirm the four AlphaSearch tables exist.
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           'optimization_runs',
           'optimization_trials',
           'optimization_schedules',
           'optimization_strategies',
           'strategy_validations'
         )
       ORDER BY table_name`,
  );
  console.log(
    `AlphaSearch tables present (5 expected): ${tables.rows.length} found — ${tables.rows.map((r) => r.table_name).join(", ")}`,
  );

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
