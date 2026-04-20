/**
 * Test NW Sportsbook API timing
 * Run with: npx tsx scripts/test-nwsb-timing.ts
 */

import { performance } from "perf_hooks";
import { NineWicketsSportsbookAtomsAdapter } from "../lib/atoms/adapters/ninewickets-sportsbook";
import { ninewicketsExchangeAdapter } from "../lib/adapters/ninewickets-exchange";

async function main() {
  console.log("Fetching events from NW Exchange to get event IDs...");
  const events = await ninewicketsExchangeAdapter.fetchEvents();
  console.log("Found", events.length, "events");

  if (events.length === 0) {
    console.log("No events found");
    return;
  }

  // Pick a few events to test
  const testEvents = events.slice(0, 5);

  const adapter = new NineWicketsSportsbookAtomsAdapter();

  console.log("\n--- Testing NW Sportsbook 2-step flow ---\n");

  const timings: number[] = [];

  for (const event of testEvents) {
    const providerEventId = event.providers["ninewickets-exchange"]?.eventId;
    if (!providerEventId) continue;

    console.log(`Event: ${event.homeTeam} vs ${event.awayTeam}`);

    const start = performance.now();
    const count = await adapter.fetchAndStoreOdds(
      providerEventId,
      `test-${event.id}`,
      event.homeTeam,
      event.awayTeam,
    );
    const elapsed = performance.now() - start;

    console.log(`  Odds: ${count}, Time: ${elapsed.toFixed(0)}ms`);
    timings.push(elapsed);
  }

  console.log("\n=== SUMMARY ===");
  console.log(
    "Avg time per event:",
    (timings.reduce((a, b) => a + b, 0) / timings.length).toFixed(0),
    "ms",
  );
  console.log("Min:", Math.min(...timings).toFixed(0), "ms");
  console.log("Max:", Math.max(...timings).toFixed(0), "ms");
  console.log("\nThis time includes BOTH Step 1 (catalog) and Step 2 (odds)");
}

main().catch(console.error);
