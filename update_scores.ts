import 'dotenv/config';
import { db, ensureDbReady } from './lib/db/client';
import { bets } from './lib/db/schema';
import { sql } from 'drizzle-orm';
async function run() {
  await ensureDbReady();
  const res = await db.execute(sql`SELECT count(*) FROM bets WHERE ml_score = 1`);
  console.log('Count of mlScore=1:', res.rows[0].count);
  process.exit(0);
}
run();
