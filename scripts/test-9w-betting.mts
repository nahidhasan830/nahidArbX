import { db } from "../lib/db/client";
import { bets } from "../lib/db/schema";
import { desc, eq, and } from "drizzle-orm";
import { getBettingProvider } from "../lib/betting/registry";

async function main() {
  console.log("Finding an active value bet for ninewickets-sportsbook...");
  const recentBets = await db
    .select()
    .from(bets)
    .where(
      and(
        eq(bets.softProvider, "ninewickets-sportsbook"),
        eq(bets.outcome, "pending"),
      ),
    )
    .orderBy(desc(bets.createdAt))
    .limit(10);

  if (recentBets.length === 0) {
    console.error(
      "No pending 9w value bets found in the database. Cannot run test.",
    );
    process.exit(1);
  }

  // Find one where the event has not started yet ideally, or just the most recent
  const testBet = recentBets[0];
  console.log(`Selected Value Bet: ${testBet.id}`);
  console.log(`Event: ${testBet.homeTeam} vs ${testBet.awayTeam}`);
  console.log(
    `Market: ${testBet.marketType} | Selection: ${testBet.atomLabel}`,
  );

  const provider = getBettingProvider(testBet.softProvider);
  if (!provider) {
    console.error("Provider ninewickets-sportsbook not found.");
    process.exit(1);
  }

  console.log("\nResolving Provider Refs...");
  const refs = await provider.resolveProviderRefs({
    normalizedEventId: testBet.eventId,
    familyId: testBet.familyId,
    atomId: testBet.atomId,
    homeTeam: testBet.homeTeam,
    awayTeam: testBet.awayTeam,
    sport: "soccer", // hardcode for test convenience or could infer
  });

  if (!refs) {
    console.error("Failed to resolve provider refs. Market might be closed.");
    process.exit(1);
  }

  console.log("Resolved Refs:", refs);

  console.log("\n=== TEST 1: Below Minimum Amount (Stake: 50 BDT) ===");
  const resMin = await provider.placeBet({
    providerRefs: refs,
    stake: 50,
    odds: Number(testBet.softOdds),
    currency: "BDT",
  });
  console.log("Result for Below Min:", JSON.stringify(resMin, null, 2));

  console.log("\n=== TEST 2: Huge Stake Amount (Stake: 5,000,000 BDT) ===");
  const resHuge = await provider.placeBet({
    providerRefs: refs,
    stake: 5000000,
    odds: Number(testBet.softOdds),
    currency: "BDT",
  });
  console.log("Result for Huge Stake:", JSON.stringify(resHuge, null, 2));

  console.log("\n=== TEST 3: Safe Bet with Modified Lower Odds ===");
  // Typically we expect current odds to be >= requested odds. If we request very high odds,
  // it might reject with "PRICE_CHANGED" or "INVALID_ODDS".
  // Let's test with slightly higher odds to see if we get a price change error.
  console.log(`Testing with odds: ${Number(testBet.softOdds) * 1.5}`);
  const resOdds = await provider.placeBet({
    providerRefs: refs,
    stake: 120, // Min stake to be safe
    odds: Number(testBet.softOdds) * 1.5,
    currency: "BDT",
  });
  console.log("Result for Changed Odds:", JSON.stringify(resOdds, null, 2));

  console.log("\n=== TEST 4: Safe Successful Bet ===");
  console.log(`Testing with original odds: ${testBet.softOdds}`);
  // Placing a real bet now. 120 BDT is about ~$1.
  const resSafe = await provider.placeBet({
    providerRefs: refs,
    stake: 120,
    odds: Number(testBet.softOdds),
    currency: "BDT",
  });
  console.log("Result for Safe Bet:", JSON.stringify(resSafe, null, 2));

  process.exit(0);
}

main().catch((err) => {
  console.error("Test script failed:", err);
  process.exit(1);
});
