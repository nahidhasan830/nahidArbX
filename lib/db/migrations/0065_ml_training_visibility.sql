-- Live ML training visibility
--
-- Adds heartbeat/progress columns to ml_models so the dashboard can
-- show the current stage, message, and estimated remaining time.

ALTER TABLE "ml_models"
  ADD COLUMN IF NOT EXISTS "training_stage" text;
--> statement-breakpoint
ALTER TABLE "ml_models"
  ADD COLUMN IF NOT EXISTS "progress_message" text;
--> statement-breakpoint
ALTER TABLE "ml_models"
  ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "ml_models"
  ADD COLUMN IF NOT EXISTS "estimated_time_remaining_ms" integer;
--> statement-breakpoint
