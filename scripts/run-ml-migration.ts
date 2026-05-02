/**
 * Run the ML pipeline migration (0040) using the app's Cloud SQL Connector pool.
 *
 * Usage: npx tsx scripts/run-ml-migration.ts
 */

import "dotenv/config";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import pg from "pg";
import fs from "fs";
import path from "path";

const { Pool } = pg;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const instance = process.env.CLOUD_SQL_INSTANCE;

  if (!databaseUrl) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }

  let pool: pg.Pool;

  if (instance) {
    const url = new URL(databaseUrl);
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const database = url.pathname.slice(1);

    console.log(`Connecting via Cloud SQL Connector: ${instance}`);
    const connector = new Connector();
    const clientOpts = await connector.getOptions({
      instanceConnectionName: instance,
      ipType: IpAddressTypes.PUBLIC,
    });
    pool = new Pool({ ...clientOpts, user, password, database, max: 2 });
  } else {
    console.log(`Connecting via DATABASE_URL`);
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
  }

  // Test connection
  const testRes = await pool.query("SELECT 1 AS ok");
  console.log("Connection OK:", testRes.rows[0]);

  // Read migration SQL
  const __dirname = path.dirname(new URL(import.meta.url).pathname);
  const migrationPath = path.join(
    __dirname,
    "../lib/db/migrations/0040_ml_pipeline.sql",
  );
  const sql = fs.readFileSync(migrationPath, "utf-8");

  // Split on --> statement-breakpoint
  const statements = sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`Running ${statements.length} statements...`);

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const preview = stmt.substring(0, 80).replace(/\n/g, " ");
    try {
      await pool.query(stmt);
      console.log(`  [${i + 1}/${statements.length}] ✅ ${preview}...`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Skip "already exists" errors (idempotent re-runs)
      if (
        msg.includes("already exists") ||
        msg.includes("duplicate key") ||
        msg.includes("column") && msg.includes("of relation") && msg.includes("already exists")
      ) {
        console.log(`  [${i + 1}/${statements.length}] ⏭️  Already applied: ${preview}...`);
      } else {
        console.error(`  [${i + 1}/${statements.length}] ❌ ${preview}...`);
        console.error(`     Error: ${msg}`);
        throw err;
      }
    }
  }

  console.log("\n✅ Migration 0040_ml_pipeline applied successfully!");

  // Verify: check the new columns exist
  const cols = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'bets' AND column_name IN ('ml_features', 'ml_score', 'ml_kelly_adjusted')
    ORDER BY column_name
  `);
  console.log("\nVerification — new bets columns:");
  for (const row of cols.rows) {
    console.log(`  ${row.column_name}: ${row.data_type}`);
  }

  const mlTable = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'ml_models'
    ORDER BY ordinal_position
    LIMIT 10
  `);
  console.log(`\nVerification — ml_models table (${mlTable.rows.length} columns shown):`);
  for (const row of mlTable.rows) {
    console.log(`  ${row.column_name}: ${row.data_type}`);
  }

  const settingsCol = await pool.query(`
    SELECT column_name, data_type, column_default
    FROM information_schema.columns
    WHERE table_name = 'betting_settings' AND column_name = 'ml_min_score'
  `);
  console.log(`\nVerification — betting_settings.ml_min_score:`);
  for (const row of settingsCol.rows) {
    console.log(`  ${row.column_name}: ${row.data_type} (default: ${row.column_default})`);
  }

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
