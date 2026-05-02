/**
 * Cleanup script — wipes all obsolete optimizer data:
 *   - optimization_trials (FK cascade from runs)
 *   - optimization_runs
 *   - optimization_strategies
 *   - optimization_schedules
 *   - betting_settings.active_strategy_ids → []
 *
 * Uses the Cloud SQL connector SDK directly (same as lib/db/client.ts).
 */

import pg from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { config } from "dotenv";

config(); // load .env

const databaseUrl = process.env.DATABASE_URL;
const instance = process.env.CLOUD_SQL_INSTANCE;

if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

async function buildPool() {
  if (!instance) {
    return new pg.Pool({ connectionString: databaseUrl, max: 2 });
  }
  const url = new URL(databaseUrl);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = url.pathname.slice(1);

  const connector = new Connector();
  const clientOpts = await connector.getOptions({
    instanceConnectionName: instance,
    ipType: IpAddressTypes.PUBLIC,
  });
  return new pg.Pool({ ...clientOpts, user, password, database, max: 2 });
}

const pool = await buildPool();

try {
  // Count before
  const before = {};
  for (const table of ["optimization_trials", "optimization_runs", "optimization_strategies", "optimization_schedules"]) {
    const r = await pool.query(`SELECT count(*)::int as n FROM ${table}`);
    before[table] = r.rows[0].n;
  }
  console.log("Before cleanup:", before);

  // Truncate (trials cascade from runs via FK)
  await pool.query("TRUNCATE optimization_trials, optimization_runs, optimization_strategies, optimization_schedules CASCADE");

  // Reset active_strategy_ids in betting_settings
  await pool.query("UPDATE betting_settings SET active_strategy_ids = '[]'::jsonb WHERE id = 1");

  // Verify
  const after = {};
  for (const table of ["optimization_trials", "optimization_runs", "optimization_strategies", "optimization_schedules"]) {
    const r = await pool.query(`SELECT count(*)::int as n FROM ${table}`);
    after[table] = r.rows[0].n;
  }
  console.log("After cleanup:", after);

  const settings = await pool.query("SELECT active_strategy_ids FROM betting_settings WHERE id = 1");
  console.log("active_strategy_ids:", settings.rows[0]?.active_strategy_ids);

  console.log("\n✅ All optimizer data wiped successfully.");
} catch (err) {
  console.error("Cleanup failed:", err);
  process.exit(1);
} finally {
  await pool.end();
  process.exit(0);
}
