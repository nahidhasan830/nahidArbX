import "dotenv/config";
import {
  queryGeniusSportsCatalog,
  fetchAllEvents,
} from "../lib/betting/velki/events-client";

async function main() {
  console.log("Fetching Velki events...");
  const events = await fetchAllEvents();
  console.log(`Found ${events.length} events`);

  for (const evt of events.slice(0, 5)) {
    const eid = String(evt.id);
    console.log(`\n=== ${evt.name} (${eid}) ===`);
    try {
      const catalog = await queryGeniusSportsCatalog(eid);
      const markets = catalog.geniusSportsMarkets ?? [];
      const totalMarkets = markets.filter((m) => {
        const name = (m.marketName ?? "").toLowerCase();
        return (
          name.includes("total") ||
          name.includes("over / under") ||
          name.includes("over/under")
        );
      });
      if (totalMarkets.length > 0) {
        console.log(`  ${totalMarkets.length} total/OU markets:`);
        for (const m of totalMarkets.slice(0, 15)) {
          console.log(`    "${m.marketName}" (type=${m.apiSiteMarketType})`);
        }
        // Found what we need
        break;
      } else {
        console.log("  No total/OU markets");
      }
    } catch (e: any) {
      console.log(`  Error: ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
