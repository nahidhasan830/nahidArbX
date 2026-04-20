import { ninewicketsSportsbookAdapter } from "../lib/betting/ninewickets/adapter.js";
import { getSession } from "../lib/betting/ninewickets/session.js";

async function main() {
  const refs = {
    apiSiteType: 5,
    eventType: "1",
    eventId: "35458375", // A known event ID
    marketId: "143384260", // A known market ID
    selectionId: 11330, // A known selection ID
  };

  // 1. Below Min
  const res1 = await ninewicketsSportsbookAdapter.placeBet({
    providerRefs: refs,
    stake: 50,
    odds: 2.1,
    currency: "BDT",
  });
  console.log("Below Min Result:", JSON.stringify(res1, null, 2));

  // 2. Huge Amount
  const res2 = await ninewicketsSportsbookAdapter.placeBet({
    providerRefs: refs,
    stake: 5000000,
    odds: 2.1,
    currency: "BDT",
  });
  console.log("Huge Amount Result:", JSON.stringify(res2, null, 2));

  process.exit(0);
}
main();
