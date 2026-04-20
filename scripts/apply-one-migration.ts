/**
 * Apply a single migration file by path. Lighter than the multi-file
 * migrator when only one file is new.
 *   Usage: npx tsx --env-file=.env scripts/apply-one-migration.ts <file.sql>
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";

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

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error("pass the SQL file path as argv[2]");
  const pool = await buildPool();
  const ddl = readFileSync(resolve(process.cwd(), path), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  for (const stmt of ddl
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    process.stdout.write(`→ ${stmt.slice(0, 80).replace(/\s+/g, " ")}… `);
    await pool.query(stmt);
    process.stdout.write("ok\n");
  }
  await pool.end();
  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
