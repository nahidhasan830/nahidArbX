-- Add AI Search escalation config columns to matcher_config.
-- Tier 2.5: uncertain ML pairs escalate to local Gemma 4 + web search
-- before routing to human_review.
ALTER TABLE "matcher_config"
  ADD COLUMN IF NOT EXISTS "ai_search_enabled" boolean NOT NULL DEFAULT true;

ALTER TABLE "matcher_config"
  ADD COLUMN IF NOT EXISTS "ai_search_confidence_threshold" integer NOT NULL DEFAULT 70;

ALTER TABLE "matcher_config"
  ADD COLUMN IF NOT EXISTS "ai_search_max_batch_size" integer NOT NULL DEFAULT 20;

-- Add AI Search stats columns to matcher_runs so the UI can show
-- per-run AI Search resolution counts.
ALTER TABLE "matcher_runs"
  ADD COLUMN IF NOT EXISTS "ai_search_attempted" integer NOT NULL DEFAULT 0;

ALTER TABLE "matcher_runs"
  ADD COLUMN IF NOT EXISTS "ai_search_merged" integer NOT NULL DEFAULT 0;

ALTER TABLE "matcher_runs"
  ADD COLUMN IF NOT EXISTS "ai_search_rejected" integer NOT NULL DEFAULT 0;
