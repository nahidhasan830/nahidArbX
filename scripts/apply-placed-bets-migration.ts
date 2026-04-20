/**
 * Apply the placed_bets migrations (0012 and 0013) to the Cloud SQL DB.
 * Uses the Cloud SQL Connector directly so we don't need the local
 * proxy running. Safe to re-run — all DDL uses IF NOT EXISTS.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";

async function buildPool(): Promise<Pool> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const instance = process.env.CLOUD_SQL_INSTANCE;
  if (!instance) return new Pool({ connectionString, max: 2 });

  const url = new URL(connectionString);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = url.pathname.slice(1);

  const connector = new Connector();
  const clientOpts = await connector.getOptions({
    instanceConnectionName: instance,
    ipType: IpAddressTypes.PUBLIC,
  });
  return new Pool({ ...clientOpts, user, password, database, max: 2 });
}

async function apply(pool: Pool, path: string) {
  const ddl = readFileSync(resolve(process.cwd(), path), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const statements = ddl
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  console.log(`\n→ Applying ${path} (${statements.length} statements)`);
  for (const stmt of statements) {
    const preview = stmt.replace(/\s+/g, " ").slice(0, 70);
    process.stdout.write(`   ${preview}… `);
    await pool.query(stmt);
    process.stdout.write("ok\n");
  }
}

async function main() {
  const pool = await buildPool();
  await apply(pool, "lib/db/migrations/0012_placed_bets.sql");
  await apply(pool, "lib/db/migrations/0013_placed_bets_strategy_id.sql");

  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM placed_bets`,
  );
  console.log(`\nplaced_bets rows: ${rows[0]?.n ?? 0}`);
  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
