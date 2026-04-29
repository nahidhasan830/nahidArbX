import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { marketAnomalies } from "./lib/db/schema";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { casing: "snake_case" });
  try {
    const res = await db.select().from(marketAnomalies);
    console.log(res);
  } catch (e) {
    console.error((e as Error).message);
  } finally {
    process.exit(0);
  }
}
main();
