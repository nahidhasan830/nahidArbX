ALTER TABLE "settlement_runs"
  ADD COLUMN IF NOT EXISTS "events_total" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "events_attempted" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "events_skipped_by_backoff" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "events_resolved_from_cache" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "events_resolved_by_espn" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "events_resolved_by_sofa_score" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "events_resolved_by_api_football" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "events_still_unresolved" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "api_football_requests_used" integer NOT NULL DEFAULT 0;
