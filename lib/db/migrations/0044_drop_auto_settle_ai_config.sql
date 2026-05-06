-- Drop the auto-settle AI configuration columns from betting_settings.
-- These were used to optionally force AI (Gemini) into the auto-settlement
-- pipeline. Settlement is now deterministic-only (Tier 0/1/2), so the
-- columns are dead code.

ALTER TABLE "betting_settings" DROP COLUMN IF EXISTS "auto_settle_force_ai";
ALTER TABLE "betting_settings" DROP COLUMN IF EXISTS "auto_settle_ai_model";
