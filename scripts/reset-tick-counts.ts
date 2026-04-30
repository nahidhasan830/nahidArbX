/**
 * One-shot fix script: delete all pending unplaced bets with inflated tick_count.
 * The reactive detector will re-detect and re-insert them with tick_count=1.
 *
 * Run: npx tsx scripts/reset-tick-counts.ts
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { bets } from "../lib/db/schema";
import { sql } from "drizzle-orm";

async function buildPool(): Promise<Pool> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const instance = process.env.CLOUD_SQL_INSTANCE;
  if (!instance) return new Pool({ connectionString: databaseUrl, max: 5 });

  const url = new URL(databaseUrl);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = url.pathname.slice(1);

  const connector = new Connector();
  const clientOpts = await connector.getOptions({
    instanceConnectionName: instance,
    ipType: IpAddressTypes.PUBLIC,
  });
  return new Pool({ ...clientOpts, user, password, database, max: 5 });
}

async function main() {
  const pool = await buildPool();
  const db = drizzle(pool, { schema: { bets }, casing: "snake_case" });

  const result = await db
    .delete(bets)
    .where(
      sql`${bets.placedAt} IS NULL AND ${bets.outcome} = 'pending'`,
    )
    .returning({ id: bets.id, tick: bets.tickCount });

  console.log(`Deleted ${result.length} pending unplaced bets:`);
  for (const r of result) {
    console.log(`  ${r.id}  (tick_count was ${r.tick})`);
  }

  await pool.end();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
