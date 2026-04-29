import { db } from "./lib/db/client";
import { marketAnomalies } from "./lib/db/schema";
import { desc } from "drizzle-orm";

async function main() {
  try {
    const res = await db.select().from(marketAnomalies).orderBy(desc(marketAnomalies.createdAt)).limit(10);
    console.log("Success:", res);
  } catch (err) {
    console.error("Error:", err);
  } finally {
    process.exit(0);
  }
}
main();
