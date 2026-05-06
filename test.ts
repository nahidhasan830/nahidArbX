import 'dotenv/config';
import { db, ensureDbReady } from './lib/db/client';
import { bets } from './lib/db/schema';
import { isNotNull, desc } from 'drizzle-orm';
async function run() {
  await ensureDbReady();
  const res = await db.select({ mlScore: bets.mlScore }).from(bets).where(isNotNull(bets.mlScore)).orderBy(desc(bets.firstSeenAt)).limit(5);
  console.log(res);
  process.exit(0);
}
run();
