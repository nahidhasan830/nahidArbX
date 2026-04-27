import { db } from "./lib/db/client.ts";
import { bets } from "./lib/db/schema.ts";
import { eq } from "drizzle-orm";

async function main() {
  const allBets = await db
    .select()
    .from(bets)
    .where(eq(bets.mode, "manual"))
    .limit(10);
  console.log("Found manual bets:", allBets.length);
  if (allBets.length > 0) {
    console.log("First bet ID:", allBets[0].id);
    console.log("First bet placedAt:", allBets[0].placedAt);
    console.log("First bet outcome:", allBets[0].outcome);
  }
}
main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
