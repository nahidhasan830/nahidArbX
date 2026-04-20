/**
 * One-shot runner for the two migrations added this session:
 *   0014_placed_bets_dedup_unique.sql — promote dedup index to UNIQUE
 *   0015_betting_settings.sql         — create betting_settings singleton
 *
 * Uses a standalone pg Pool (avoids importing the app's client.ts
 * which relies on top-level await incompatible with tsx/CJS). Same
 * DATABASE_URL the app uses.
 *
 * Usage: DATABASE_URL=... npx tsx scripts/apply-pending-migrations.ts
 *        (cloud-sql-proxy on 127.0.0.1:5432 must be running)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import "dotenv/config";

const MIGRATIONS = [
  "0014_placed_bets_dedup_unique.sql",
  "0015_betting_settings.sql",
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

  const seed = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM betting_settings WHERE id = 1",
  );
  console.log(
    `\nbetting_settings rows with id=1: ${seed.rows[0].n} ${seed.rows[0].n === 1 ? "✓" : "(expected 1)"}`,
  );

  const idx = await pool.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'placed_bets_dedup_idx'`,
  );
  const def = idx.rows[0]?.indexdef ?? "";
  console.log(`placed_bets_dedup_idx: ${def || "(missing)"}`);
  console.log(`  unique? ${def.toLowerCase().includes("unique") ? "✓" : "✗"}`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
