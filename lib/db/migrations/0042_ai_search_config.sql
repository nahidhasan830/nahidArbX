-- Legacy Matcher Lab AI Search config.
-- No-op after 0076 drops matcher_config and matcher_runs.
DO $$
BEGIN
  IF to_regclass('public.matcher_config') IS NOT NULL THEN
    ALTER TABLE "matcher_config"
      ADD COLUMN IF NOT EXISTS "ai_search_enabled" boolean NOT NULL DEFAULT true;

    ALTER TABLE "matcher_config"
      ADD COLUMN IF NOT EXISTS "ai_search_confidence_threshold" integer NOT NULL DEFAULT 70;

    ALTER TABLE "matcher_config"
      ADD COLUMN IF NOT EXISTS "ai_search_max_batch_size" integer NOT NULL DEFAULT 20;
  END IF;

  IF to_regclass('public.matcher_runs') IS NOT NULL THEN
    ALTER TABLE "matcher_runs"
      ADD COLUMN IF NOT EXISTS "ai_search_attempted" integer NOT NULL DEFAULT 0;

    ALTER TABLE "matcher_runs"
      ADD COLUMN IF NOT EXISTS "ai_search_merged" integer NOT NULL DEFAULT 0;

    ALTER TABLE "matcher_runs"
      ADD COLUMN IF NOT EXISTS "ai_search_rejected" integer NOT NULL DEFAULT 0;
  END IF;
END $$;
