/**
 * Apply the 0005_match_scores migration to the Cloud SQL DB.
 * Opens its own pool so we don't depend on lib/db/client.ts (which uses
 * top-level await that tsx's CJS transform can't handle).
 *
 * Safe to re-run — all DDL uses IF NOT EXISTS.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";

const MIG_FILES = [
  "lib/db/migrations/0005_match_scores.sql",
  "lib/db/migrations/0006_settlement_runs.sql",
  "lib/db/migrations/0007_settlement_disputes.sql",
  "lib/db/migrations/0008_match_scores_corners.sql",
  "lib/db/migrations/0009_drop_is_dummy.sql",
  "lib/db/migrations/0010_settled_by_source.sql",
  "lib/db/migrations/0011_settle_attempts.sql",
];

async function buildPool(): Promise<Pool> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const instance = process.env.CLOUD_SQL_INSTANCE;
  if (!instance) {
    return new Pool({ connectionString, max: 2 });
  }

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

async function applyFile(pool: Pool, path: string): Promise<void> {
  const ddl = readFileSync(resolve(process.cwd(), path), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const statements = ddl
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`\n── ${path} ──`);
  for (const stmt of statements) {
    process.stdout.write(`→ ${stmt.slice(0, 80).replace(/\s+/g, " ")}… `);
    await pool.query(stmt);
    process.stdout.write("ok\n");
  }
}

async function main(): Promise<void> {
  const pool = await buildPool();
  for (const f of MIG_FILES) await applyFile(pool, f);

  const counts = await Promise.all(
    ["match_scores", "settlement_runs", "settlement_disputes"].map(
      async (t) => {
        const { rows } = await pool.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM "${t}"`,
        );
        return [t, rows[0]?.n ?? 0] as const;
      },
    ),
  );
  const { rows: colCheck } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_name='value_bets' AND column_name IN ('is_dummy','settled_by_source')
        AND column_name IN ('is_dummy','settled_by_source')`,
  );
  const { rows: dummyGone } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_name='value_bets' AND column_name='is_dummy'`,
  );
  const { rows: sourceThere } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_name='value_bets' AND column_name='settled_by_source'`,
  );
  console.log();
  for (const [t, n] of counts) {
    console.log(`${t.padEnd(22)} rows: ${n}`);
  }
  console.log(
    `is_dummy column gone:      ${dummyGone[0]?.n === 0 ? "yes" : "NO"}`,
  );
  console.log(
    `settled_by_source column:  ${sourceThere[0]?.n === 1 ? "yes" : "NO"}`,
  );
  void colCheck;
  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
