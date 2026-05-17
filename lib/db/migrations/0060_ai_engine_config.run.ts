/**
 * One-shot migration: create ai_engine_config table.
 * Run with: npx tsx lib/db/migrations/0060_ai_engine_config.run.ts
 */
import { ensureDbReady, db } from "@/lib/db/client";
import { sql } from "drizzle-orm";

async function main() {
  await ensureDbReady();
  console.log("Creating ai_engine_config table...");
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ai_engine_config (
      name       TEXT PRIMARY KEY,
      enabled    BOOLEAN NOT NULL DEFAULT true,
      disabled_reason TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    INSERT INTO ai_engine_config (name, enabled)
    VALUES ('deepseek', true)
    ON CONFLICT (name) DO NOTHING
  `);

  await db.execute(sql`
    INSERT INTO ai_engine_config (name, enabled)
    VALUES ('gemini', true)
    ON CONFLICT (name) DO NOTHING
  `);

  const rows = await db.execute(sql`SELECT * FROM ai_engine_config`);
  console.log("Done:", rows.rows);
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
