#!/usr/bin/env npx tsx
/**
 * Creates the ai_activity_log table if it doesn't exist.
 * Run: npx tsx scripts/migrate-ai-activity-log.ts
 */
import "dotenv/config";
import { ensureDbReady, db } from "../lib/db/client.js";
import { sql } from "drizzle-orm";

async function run() {
  await ensureDbReady();

  console.log("Checking if ai_activity_log table exists...");

  // Check existence
  const check = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables 
      WHERE table_name = 'ai_activity_log'
    ) as exists
  `);

  if (check.rows[0]?.exists) {
    console.log("✓ Table already exists.");
    const count = await db.execute(sql`SELECT count(*)::int as cnt FROM ai_activity_log`);
    console.log(`  Rows: ${count.rows[0]?.cnt}`);
    process.exit(0);
  }

  console.log("Creating ai_activity_log table...");

  await db.execute(sql`
    CREATE TABLE ai_activity_log (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      system TEXT NOT NULL,
      trigger TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL,
      model TEXT,
      item_count INTEGER,
      duration_ms INTEGER,
      cost_usd NUMERIC(8, 5),
      summary TEXT,
      error TEXT,
      metadata JSONB
    )
  `);

  await db.execute(sql`
    CREATE INDEX ai_activity_log_created_idx ON ai_activity_log (created_at DESC)
  `);
  await db.execute(sql`
    CREATE INDEX ai_activity_log_system_idx ON ai_activity_log (system)
  `);
  await db.execute(sql`
    CREATE INDEX ai_activity_log_status_idx ON ai_activity_log (status)
  `);

  console.log("✓ Table created with 3 indexes.");
  process.exit(0);
}

run().catch((e) => {
  console.error("Migration failed:", e.message);
  process.exit(1);
});
