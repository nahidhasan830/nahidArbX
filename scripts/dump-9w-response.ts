/**
 * Dump the most recent 9W placement response payloads from the bets table.
 * Used to confirm whether the response nests the ticket id inside
 * `unMatchTicket`/`txn` (the bug we fixed for Velki).
 */
import "dotenv/config";
import { Pool } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";

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
  // Look for genuine JSON placement responses (skip HTML logoff stubs).
  // The confirmation tracker writes a wrapper {placementResponse, confirmedFromFeedTicket}
  // — for our purposes either is fine as long as we can see what the
  // raw book response looks like.
  const { rows } = await pool.query(
    `select id, provider_ticket_id, placed_at,
            response_payload::text as response_text
       from bets
      where provider = 'ninewickets-sportsbook'
        and placed_at is not null
        and response_payload is not null
        and response_payload::text like '{%'
      order by placed_at desc
      limit 5`,
  );
  for (const r of rows) {
    console.log("=".repeat(60));
    console.log("ticket:", r.provider_ticket_id, "placed:", r.placed_at);
    const text = String(r.response_text);
    console.log(
      text.length > 2500 ? text.slice(0, 2500) + "\n... [truncated]" : text,
    );
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
