#!/usr/bin/env npx tsx
/**
 * Diagnostic: check what value bets are in memory vs DB
 * Run with: npx tsx scripts/check-value-persist.ts
 */
import "dotenv/config";
import { db } from "../lib/db/client";
import { bets } from "../lib/db/schema";
import { desc, sql } from "drizzle-orm";

async function main() {
  // 1. Get recent bets from DB
  const recentBets = await db
    .select({
      id: bets.id,
      homeTeam: bets.homeTeam,
      awayTeam: bets.awayTeam,
      familyId: bets.familyId,
      atomId: bets.atomId,
      marketType: bets.marketType,
      tickCount: bets.tickCount,
      firstSeenAt: bets.firstSeenAt,
      lastSeenAt: bets.lastSeenAt,
    })
    .from(bets)
    .orderBy(desc(bets.firstSeenAt))
    .limit(20);

  console.log("\n=== 20 Most Recent Bets (by firstSeenAt) ===");
  for (const b of recentBets) {
    console.log(
      `  ${b.homeTeam} vs ${b.awayTeam} | ${b.familyId}|${b.atomId} (${b.marketType}) | ticks=${b.tickCount} | first=${b.firstSeenAt} | last=${b.lastSeenAt}`,
    );
  }

  // 2. Market type distribution
  const marketDist = await db
    .select({
      marketType: bets.marketType,
      count: sql<number>`count(*)`,
    })
    .from(bets)
    .groupBy(bets.marketType)
    .orderBy(sql`count(*) DESC`);

  console.log("\n=== Market Type Distribution ===");
  for (const m of marketDist) {
    console.log(`  ${m.marketType}: ${m.count}`);
  }

  // 3. Check for Monastir bets specifically
  const monastirBets = await db
    .select()
    .from(bets)
    .where(sql`${bets.homeTeam} ILIKE '%Monastir%' OR ${bets.awayTeam} ILIKE '%Monastir%'`);

  console.log(`\n=== Monastir Bets: ${monastirBets.length} ===`);
  for (const b of monastirBets) {
    console.log(
      `  ${b.familyId}|${b.atomId} (${b.marketType}) softOdds=${b.softOdds} sharpOdds=${b.sharpOdds} ticks=${b.tickCount}`,
    );
  }

  // 4. Check bets from the last 2 hours
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const recentlyInserted = await db
    .select({
      id: bets.id,
      homeTeam: bets.homeTeam,
      awayTeam: bets.awayTeam,
      marketType: bets.marketType,
      firstSeenAt: bets.firstSeenAt,
    })
    .from(bets)
    .where(sql`${bets.firstSeenAt} > ${twoHoursAgo}`)
    .orderBy(desc(bets.firstSeenAt));

  console.log(
    `\n=== Bets with firstSeenAt in last 2h: ${recentlyInserted.length} ===`,
  );
  for (const b of recentlyInserted.slice(0, 10)) {
    console.log(`  ${b.homeTeam} vs ${b.awayTeam} (${b.marketType}) first=${b.firstSeenAt}`);
  }

  // 5. Check recently UPDATED bets (lastSeenAt in last 30 min)
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const recentlyUpdated = await db
    .select({
      id: bets.id,
      homeTeam: bets.homeTeam,
      awayTeam: bets.awayTeam,
      marketType: bets.marketType,
      tickCount: bets.tickCount,
      lastSeenAt: bets.lastSeenAt,
    })
    .from(bets)
    .where(sql`${bets.lastSeenAt} > ${thirtyMinAgo}`)
    .orderBy(desc(bets.lastSeenAt));

  console.log(
    `\n=== Bets with lastSeenAt in last 30min: ${recentlyUpdated.length} ===`,
  );
  for (const b of recentlyUpdated.slice(0, 10)) {
    console.log(
      `  ${b.homeTeam} vs ${b.awayTeam} (${b.marketType}) ticks=${b.tickCount} last=${b.lastSeenAt}`,
    );
  }

  process.exit(0);
}

main().catch(console.error);
