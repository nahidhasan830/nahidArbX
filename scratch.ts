import { db } from "./lib/db/client";
import { unmappedMarkets } from "./lib/db/schema";

async function main() {
  const markets = await db.select({
    provider: unmappedMarkets.provider,
    name: unmappedMarkets.rawMarketName,
    key: unmappedMarkets.rawMarketKey,
    payload: unmappedMarkets.samplePayload
  }).from(unmappedMarkets).limit(5);
  
  console.log(JSON.stringify(markets, null, 2));
  process.exit(0);
}
main();
