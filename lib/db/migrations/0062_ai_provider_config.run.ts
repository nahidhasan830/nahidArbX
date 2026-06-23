
import { db } from "@/lib/db/client";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/shared/logger";

export async function run() {
  logger.info("Migration", "Running 0062_ai_provider_config_manual...");

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ai_provider_config (
      name TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT true,
      disabled_reason TEXT,
      model_id TEXT,
      tier TEXT,
      label TEXT,
      tagline TEXT,
      engine_type TEXT,
      total_usage_count BIGINT NOT NULL DEFAULT 0,
      monthly_usage_count INTEGER NOT NULL DEFAULT 0,
      monthly_limit INTEGER,
      last_reset_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS ai_provider_config_engine_idx ON ai_provider_config(engine_type)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS ai_provider_config_enabled_idx ON ai_provider_config(enabled)
  `);

  await db.execute(sql`
    INSERT INTO ai_provider_config (name, enabled, model_id, tier, label, tagline, engine_type, monthly_limit, total_usage_count, monthly_usage_count)
    VALUES
      ('deepseek-lite', true, 'deepseek-v4-flash', 'lite', 'DeepSeek Lite', 'Fast, cheap — default', 'llm', null, 0, 0),
      ('deepseek-pro', true, 'deepseek-v4-pro', 'pro', 'DeepSeek Pro', 'Deep reasoning', 'llm', null, 0, 0),
      ('gemini-lite', false, 'gemini-3.1-flash-lite', 'lite', 'Gemini Flash-Lite', 'Cheapest', 'llm', null, 0, 0),
      ('gemini-flash', false, 'gemini-3-flash', 'flash', 'Gemini Flash', 'Balanced', 'llm', null, 0, 0),
      ('gemini-pro', false, 'gemini-3.1-pro', 'pro', 'Gemini Pro', 'Expert', 'llm', null, 0, 0),
      ('vertex', true, 'vertex-ai-search', 'flash', 'Vertex AI Search', 'Google enterprise', 'search', null, 0, 0),
      ('brave', true, 'brave-search-api', 'flash', 'Brave Search', 'Privacy-first', 'search', 1000, 0, 762),
      ('tavily', true, 'tavily-api', 'flash', 'Tavily', 'AI-focused', 'search', 1000, 0, 1000)
    ON CONFLICT (name) DO NOTHING
  `);

  logger.info("Migration", "0062_ai_provider_config_manual complete");
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
