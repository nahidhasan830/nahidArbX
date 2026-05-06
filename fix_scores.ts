import 'dotenv/config';
import { db, ensureDbReady } from './lib/db/client';
import { sql } from 'drizzle-orm';
async function run() {
  await ensureDbReady();
  await db.execute(sql`UPDATE bets SET ml_score = NULL WHERE ml_score = 1`);
  console.log('Fixed scores.');
  process.exit(0);
}
run();
