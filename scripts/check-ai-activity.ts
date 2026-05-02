#!/usr/bin/env npx tsx
import "dotenv/config";
import { ensureDbReady, db } from '../lib/db/client.js';
import { sql } from 'drizzle-orm';

async function run() {
  await ensureDbReady();
  
  try {
    const result = await db.execute(sql`SELECT count(*)::int as cnt FROM ai_activity_log`);
    console.log('ai_activity_log table exists. Row count:', result.rows[0]?.cnt);
    
    const recent = await db.execute(sql`SELECT id, system, trigger, status, model, summary, created_at FROM ai_activity_log ORDER BY created_at DESC LIMIT 10`);
    if (recent.rows.length === 0) {
      console.log('\nNo rows yet.');
    } else {
      console.log(`\nLatest ${recent.rows.length} entries:`);
      for (const row of recent.rows) {
        console.log(`  [${row.created_at}] ${row.system} | ${row.trigger} | ${row.status} | ${row.model} | ${(row.summary as string)?.slice(0, 80)}`);
      }
    }
  } catch(e: any) {
    console.error('ERROR:', e.message);
    if (e.message.includes('does not exist') || e.message.includes('relation')) {
      console.log('\n→ Table does not exist. Need to run: npm run db:generate && npm run db:migrate');
    }
  }
  
  process.exit(0);
}

run();
