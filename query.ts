import { db } from "./lib/db/client";
import { valueBets } from "./lib/db/schema";
import { eq } from "drizzle-orm";

async function run() {
  const bets = await db
    .select()
    .from(valueBets)
    .where(eq(valueBets.homeTeam, "Atletico Madrid"))
    .limit(1);
  console.log(JSON.stringify(bets, null, 2));
  process.exit(0);
}

run();
