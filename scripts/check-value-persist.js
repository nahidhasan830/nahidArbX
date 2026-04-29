#!/usr/bin/env node
/**
 * Diagnostic: check what value bets are in the DB
 */
require("dotenv/config");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  const client = await pool.connect();

  try {
    // 1. Recent bets
    const recent = await client.query(`
      SELECT home_team, away_team, family_id, atom_id, market_type, tick_count, 
             first_seen_at, last_seen_at
      FROM bets ORDER BY first_seen_at DESC LIMIT 15
    `);
    console.log("\n=== 15 Most Recent Bets (by firstSeenAt) ===");
    for (const r of recent.rows) {
      console.log(
        `  ${r.home_team} vs ${r.away_team} | ${r.family_id}|${r.atom_id} (${r.market_type}) | ticks=${r.tick_count} | first=${r.first_seen_at.toISOString().slice(0,19)} | last=${r.last_seen_at.toISOString().slice(0,19)}`
      );
    }

    // 2. Market type distribution
    const dist = await client.query(`
      SELECT market_type, count(*) as cnt FROM bets GROUP BY market_type ORDER BY cnt DESC
    `);
    console.log("\n=== Market Type Distribution ===");
    for (const r of dist.rows) console.log(`  ${r.market_type}: ${r.cnt}`);

    // 3. Monastir bets
    const monastir = await client.query(`
      SELECT family_id, atom_id, market_type, soft_odds, sharp_odds, tick_count, first_seen_at, last_seen_at
      FROM bets WHERE home_team ILIKE '%Monastir%' OR away_team ILIKE '%Monastir%'
    `);
    console.log(`\n=== Monastir Bets: ${monastir.rowCount} ===`);
    for (const r of monastir.rows) {
      console.log(`  ${r.family_id}|${r.atom_id} (${r.market_type}) soft=${r.soft_odds} sharp=${r.sharp_odds} ticks=${r.tick_count} first=${r.first_seen_at.toISOString().slice(0,19)} last=${r.last_seen_at.toISOString().slice(0,19)}`);
    }

    // 4. Bets from last 2 hours
    const recent2h = await client.query(`
      SELECT home_team, away_team, market_type, first_seen_at 
      FROM bets WHERE first_seen_at > now() - interval '2 hours'
      ORDER BY first_seen_at DESC LIMIT 10
    `);
    console.log(`\n=== NEW Bets in last 2h: ${recent2h.rowCount} ===`);
    for (const r of recent2h.rows) {
      console.log(`  ${r.home_team} vs ${r.away_team} (${r.market_type}) first=${r.first_seen_at.toISOString().slice(0,19)}`);
    }

    // 5. Recently updated bets (last 30 min)
    const updated30m = await client.query(`
      SELECT home_team, away_team, market_type, tick_count, last_seen_at 
      FROM bets WHERE last_seen_at > now() - interval '30 minutes'
      ORDER BY last_seen_at DESC LIMIT 10
    `);
    console.log(`\n=== Bets UPDATED in last 30min: ${updated30m.rowCount} ===`);
    for (const r of updated30m.rows) {
      console.log(`  ${r.home_team} vs ${r.away_team} (${r.market_type}) ticks=${r.tick_count} last=${r.last_seen_at.toISOString().slice(0,19)}`);
    }

    // 6. Total bets count
    const total = await client.query(`SELECT count(*) as cnt FROM bets`);
    console.log(`\nTotal bets in DB: ${total.rows[0].cnt}`);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
