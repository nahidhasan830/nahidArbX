-- Rename deepseek-lite → deepseek-flash.
--
-- The "lite" tier was a misnomer: the underlying model is deepseek-v4-flash,
-- and DeepSeek only ships flash and pro. Aligning the row name + tier with
-- the model removes the confusion and matches Gemini's tier naming
-- (lite/flash/pro) where lite is meaningful.
--
-- Idempotent: safe to re-run. Uses two-step UPDATE that succeeds whether
-- the row was already renamed (in which case the first UPDATE is a no-op).

DO $$
BEGIN
  -- If the new row already exists (re-run), drop the old to avoid PK collision.
  IF EXISTS (SELECT 1 FROM ai_provider_config WHERE name = 'deepseek-flash')
     AND EXISTS (SELECT 1 FROM ai_provider_config WHERE name = 'deepseek-lite') THEN
    DELETE FROM ai_provider_config WHERE name = 'deepseek-lite';
  END IF;
END $$;
--> statement-breakpoint

UPDATE ai_provider_config
SET
  name           = 'deepseek-flash',
  tier           = 'flash',
  label          = 'DeepSeek Flash',
  tagline        = 'Fast, cheap — default',
  updated_at     = now()
WHERE name = 'deepseek-lite';
