/**
 * Inspect what Velki's queryEventsWithMarket actually returns —
 * specifically: how many pages, are events live or pre-match, etc.
 *
 * Usage:  npx tsx scripts/debug-velki-events.ts
 */
import "dotenv/config";
import {
  queryEventsWithMarket,
  fetchAllEvents,
} from "../lib/betting/velki/events-client";

async function main() {
  console.log("=== page 1 ===");
  const p1 = await queryEventsWithMarket(1, 1);
  console.log(`currentPage=${p1.currentPage}, lastPage=${p1.lastPage}`);
  console.log(`events on page 1 = ${p1.events.length}`);

  const now = Date.now();
  let live = 0;
  let preMatch = 0;
  let unknown = 0;
  for (const e of p1.events) {
    const md = e.markets?.[0]?.marketDateTime;
    const inPlay = e.markets?.[0]?.inPlay;
    if (typeof md !== "number") {
      unknown++;
      continue;
    }
    if (md < now) live++;
    else preMatch++;
    if (inPlay) {
      // count only as live
    }
  }
  console.log(`live=${live}, preMatch=${preMatch}, unknown=${unknown}`);

  // Show first 5 events with their KO times
  console.log("\nfirst 5 sample:");
  for (const e of p1.events.slice(0, 5)) {
    const md = e.markets?.[0]?.marketDateTime;
    const ko = md ? new Date(md).toISOString() : "n/a";
    const inPlay = e.markets?.[0]?.inPlay;
    console.log(
      `  [${e.id}] ${e.name}  ko=${ko}  inPlay=${inPlay ?? "?"}  comp=${e.competitionName}`,
    );
  }

  console.log("\n=== fetchAllEvents (walks pages 1..lastPage) ===");
  const all = await fetchAllEvents(1);
  let totalLive = 0;
  let totalPre = 0;
  for (const e of all) {
    const md = e.markets?.[0]?.marketDateTime;
    if (typeof md !== "number") continue;
    if (md < now) totalLive++;
    else totalPre++;
  }
  console.log(
    `total events across all pages = ${all.length}, live=${totalLive}, preMatch=${totalPre}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
