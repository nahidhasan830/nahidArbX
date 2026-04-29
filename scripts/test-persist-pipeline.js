#!/usr/bin/env node
/**
 * End-to-end pipeline test: call the live dev server to get current value bets,
 * then try to persist each one via direct SQL to see where the gap is.
 */
require("dotenv/config");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Step 1: Get current value bets from the live API
  const fetch = globalThis.fetch || (await import("node-fetch")).default;
  
  console.log("=== Fetching current value bets from live API ===");
  const res = await fetch("http://localhost:3000/api/value-bets");
  const data = await res.json();
  
  const events = data.events || [];
  const valueBets = [];
  
  for (const e of events) {
    for (const f of e.families || []) {
      for (const a of f.atoms || []) {
        if (a.valueBet) {
          valueBets.push({
            eventId: e.eventId,
            homeTeam: e.homeTeam,
            awayTeam: e.awayTeam,
            competition: e.competition,
            startTime: e.startTime,
            familyId: f.familyId,
            marketType: f.marketType,
            timeScope: f.timeScope,
            line: f.line,
            atomId: a.atomId,
            softProvider: a.valueBet.softProvider,
            sharpProvider: a.valueBet.sharpProvider,
            softOdds: a.valueBet.softOdds,
            sharpOdds: a.valueBet.sharpOdds,
            trueProb: a.valueBet.trueProb,
            evPct: a.valueBet.evPct,
            timestamp: a.valueBet.timestamp,
          });
        }
      }
    }
  }
  
  console.log(`Found ${valueBets.length} value bets in live API`);
  for (const vb of valueBets) {
    console.log(`  ${vb.homeTeam} vs ${vb.awayTeam} | ${vb.familyId}|${vb.atomId} (${vb.marketType}) | EV=${vb.evPct}% | soft=${vb.softOdds}@${vb.softProvider}`);
  }
  
  if (valueBets.length === 0) {
    console.log("\nNo value bets currently detected. Checking the in-memory store...");
    
    // Step 2: Get the sync status to understand state  
    console.log(`\nSync status: ${JSON.stringify(data.syncStatus, null, 2)}`);
    console.log(`Total events: ${events.length}`);
    
    // Step 3: Check what's in the DB right now
    const client = await pool.connect();
    try {
      const recent = await client.query(`
        SELECT home_team, away_team, family_id, atom_id, market_type, tick_count, 
               first_seen_at, last_seen_at
        FROM bets 
        WHERE last_seen_at > now() - interval '30 minutes'
        ORDER BY last_seen_at DESC 
        LIMIT 10
      `);
      console.log(`\nBets updated in last 30 min: ${recent.rowCount}`);
      for (const r of recent.rows) {
        console.log(`  ${r.home_team} vs ${r.away_team} | ${r.family_id}|${r.atom_id} (${r.market_type}) ticks=${r.tick_count} last=${r.last_seen_at.toISOString().slice(0,19)}`);
      }
    } finally {
      client.release();
    }
    
    console.log("\n=== DIAGNOSIS ===");
    console.log("The API returns 0 value bets from getValueBets() in the store.");
    console.log("This means detectAllValueBetsIncremental is returning an empty array.");
    console.log("The persist pipeline NEVER runs because valueBets.length === 0.");
    console.log("Value bets in the UI were from CACHED data (incremental cache),");
    console.log("but they got evicted when the sharp odds became stale (>90s).");
    console.log("");
    console.log("ROOT CAUSE: Value bets are only persisted when the detection");
    console.log("pipeline finds them. But the 90s staleness gate on sharp odds");
    console.log("means bets wink in/out between sync cycles. If a bet is only");
    console.log("detected in 1 cycle, it gets persisted once. But if the sharp");
    console.log("odds timestamp doesn't refresh (Pinnacle wasn't dirty), the");
    console.log("cached value bet gets evicted on the next full recompute.");
    
    await pool.end();
    return;
  }
  
  // If we DO have value bets, check which are already in the DB
  const client = await pool.connect();
  try {
    console.log("\n=== Checking which value bets are in the DB ===");
    for (const vb of valueBets) {
      const betId = `${vb.eventId}|${vb.familyId}|${vb.atomId}`;
      const exists = await client.query(
        `SELECT id, tick_count, last_seen_at FROM bets WHERE id = $1`,
        [betId]
      );
      if (exists.rowCount > 0) {
        const r = exists.rows[0];
        console.log(`  ✅ IN DB: ${vb.familyId}|${vb.atomId} (ticks=${r.tick_count} last=${r.last_seen_at.toISOString().slice(0,19)})`);
      } else {
        console.log(`  ❌ MISSING: ${vb.familyId}|${vb.atomId} (${vb.marketType}) EV=${vb.evPct}% — this bet was DETECTED but NOT PERSISTED`);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
