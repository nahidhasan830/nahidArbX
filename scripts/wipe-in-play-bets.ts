/**
 * Deletes in-play "pollution" rows from the `bets` table — rows where
 * firstSeenAt >= eventStartTime. These are invisible to the UI because
 * /bets hardcodes `preMatchOnly: true` (see lib/bets-history/hooks.ts:43),
 * but they still occupy the table and inflate the raw COUNT(*).
 *
 * Default scope preserves any row that has placement or settlement data
 * attached — `placedAt IS NOT NULL`, `outcome != 'pending'`, non-null
 * `pnl`, or non-null `providerTicketId`. Set INCLUDE_PLACED=1 to widen
 * the delete to every in-play row regardless (destroys history).
 *
 * Safety:
 *   - Preview by default. Only with CONFIRM=1 does it actually DELETE.
 *   - Single transaction: BEGIN / DELETE / COMMIT, ROLLBACK on error.
 *   - Prints an audit block before and after.
 *
 * Usage:
 *   npx tsx scripts/wipe-in-play-bets.ts                         # preview, narrow scope
 *   CONFIRM=1 npx tsx scripts/wipe-in-play-bets.ts               # delete narrow scope
 *   CONFIRM=1 INCLUDE_PLACED=1 npx tsx scripts/wipe-in-play-bets.ts  # delete every in-play row
 */
import "dotenv/config";
import { Pool, type PoolConfig } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";

async function buildPool(): Promise<Pool> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set — check .env");

  const instance = process.env.CLOUD_SQL_INSTANCE;
  if (!instance) {
    console.log("[wipe] no CLOUD_SQL_INSTANCE — using plain DATABASE_URL");
    return new Pool({ connectionString: url, max: 2 });
  }

  console.log(`[wipe] connecting via Cloud SQL connector → ${instance}`);
  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const database = parsed.pathname.slice(1);

  const connector = new Connector();
  const opts = await connector.getOptions({
    instanceConnectionName: instance,
    ipType: IpAddressTypes.PUBLIC,
  });
  const cfg: PoolConfig = { ...opts, user, password, database, max: 2 };
  return new Pool(cfg);
}

const NARROW_PREDICATE = `
  first_seen_at >= event_start_time
  AND placed_at IS NULL
  AND outcome = 'pending'
  AND pnl IS NULL
  AND provider_ticket_id IS NULL
`;

const WIDE_PREDICATE = `first_seen_at >= event_start_time`;

async function printAudit(pool: Pool): Promise<void> {
  const r = await pool.query<{
    total: string;
    in_play: string;
    unplaced_pending: string;
    placed: string;
    settled: string;
    has_pnl: string;
    has_ticket: string;
    narrow_target: string;
    wide_target: string;
  }>(`
    SELECT
      COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE first_seen_at >= event_start_time)::text AS in_play,
      COUNT(*) FILTER (
        WHERE first_seen_at >= event_start_time
          AND placed_at IS NULL
          AND outcome = 'pending'
          AND pnl IS NULL
          AND provider_ticket_id IS NULL
      )::text AS unplaced_pending,
      COUNT(*) FILTER (
        WHERE first_seen_at >= event_start_time AND placed_at IS NOT NULL
      )::text AS placed,
      COUNT(*) FILTER (
        WHERE first_seen_at >= event_start_time AND outcome <> 'pending'
      )::text AS settled,
      COUNT(*) FILTER (
        WHERE first_seen_at >= event_start_time AND pnl IS NOT NULL
      )::text AS has_pnl,
      COUNT(*) FILTER (
        WHERE first_seen_at >= event_start_time AND provider_ticket_id IS NOT NULL
      )::text AS has_ticket,
      COUNT(*) FILTER (
        WHERE first_seen_at >= event_start_time
          AND placed_at IS NULL
          AND outcome = 'pending'
          AND pnl IS NULL
          AND provider_ticket_id IS NULL
      )::text AS narrow_target,
      COUNT(*) FILTER (WHERE first_seen_at >= event_start_time)::text AS wide_target
    FROM bets
  `);
  const row = r.rows[0];
  console.log("\n── In-play bets audit ──────────────────────────────");
  console.log(`  Total bets:                           ${row.total}`);
  console.log(`  In-play (firstSeen >= kickoff):       ${row.in_play}`);
  console.log(
    `     unplaced + pending:                ${row.unplaced_pending}`,
  );
  console.log(
    `     placed (placedAt NOT NULL):        ${row.placed}   ← preserved by default`,
  );
  console.log(
    `     settled (outcome != pending):      ${row.settled}   ← preserved by default`,
  );
  console.log(
    `     has pnl:                           ${row.has_pnl}   ← preserved by default`,
  );
  console.log(
    `     has providerTicketId:              ${row.has_ticket}   ← preserved by default`,
  );
  console.log(`  Default scope (narrow):               ${row.narrow_target}`);
  console.log(`  With INCLUDE_PLACED=1 (wide):         ${row.wide_target}`);
  console.log("────────────────────────────────────────────────────\n");
}

async function main() {
  const confirm = process.env.CONFIRM === "1";
  const wide = process.env.INCLUDE_PLACED === "1";
  const predicate = wide ? WIDE_PREDICATE : NARROW_PREDICATE;
  const scopeLabel = wide
    ? "WIDE (includes placed/settled)"
    : "narrow (unplaced + pending only)";

  console.log(
    confirm
      ? `[wipe] CONFIRM=1 — will DELETE in-play bet rows. Scope: ${scopeLabel}.`
      : "[wipe] preview mode — set CONFIRM=1 to actually delete.",
  );

  const pool = await buildPool();
  try {
    await printAudit(pool);

    if (!confirm) {
      console.log(
        "[wipe] preview complete.\n" +
          "       Re-run with CONFIRM=1 to delete the narrow scope.\n" +
          "       Re-run with CONFIRM=1 INCLUDE_PLACED=1 to delete every in-play row\n" +
          "       (destroys placement/settlement history).",
      );
      return;
    }

    console.log(`[wipe] deleting in-play rows (scope: ${scopeLabel})…`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const del = await client.query(`DELETE FROM bets WHERE ${predicate}`);
      await client.query("COMMIT");
      console.log(`[wipe] deleted ${del.rowCount ?? 0} row(s).`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    console.log("── Post-wipe state ────────────────────────────────");
    await printAudit(pool);
    console.log("[wipe] done.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[wipe] failed:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
