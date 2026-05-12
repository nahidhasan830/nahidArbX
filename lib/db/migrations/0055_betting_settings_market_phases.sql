-- Operator controls for whether value detection and auto-placement are
-- allowed before kickoff, after kickoff, or both. Defaults preserve the
-- historical pre-match-only behavior.

ALTER TABLE "betting_settings"
  ADD COLUMN IF NOT EXISTS "value_detection_phases" jsonb NOT NULL DEFAULT '["pre_match"]'::jsonb;

ALTER TABLE "betting_settings"
  ADD COLUMN IF NOT EXISTS "bet_placement_phases" jsonb NOT NULL DEFAULT '["pre_match"]'::jsonb;

UPDATE "betting_settings"
SET
  "value_detection_phases" = COALESCE(NULLIF("value_detection_phases", '[]'::jsonb), '["pre_match"]'::jsonb),
  "bet_placement_phases" = COALESCE(NULLIF("bet_placement_phases", '[]'::jsonb), '["pre_match"]'::jsonb)
WHERE "id" = 1;

DO $$ BEGIN
  ALTER TABLE "betting_settings"
    ADD CONSTRAINT "betting_settings_value_detection_phases_check"
    CHECK (
      CASE
        WHEN jsonb_typeof("value_detection_phases") = 'array'
          THEN "value_detection_phases" <@ '["pre_match", "in_play"]'::jsonb
            AND jsonb_array_length("value_detection_phases") > 0
        ELSE false
      END
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "betting_settings"
    ADD CONSTRAINT "betting_settings_bet_placement_phases_check"
    CHECK (
      CASE
        WHEN jsonb_typeof("bet_placement_phases") = 'array'
          THEN "bet_placement_phases" <@ '["pre_match", "in_play"]'::jsonb
            AND jsonb_array_length("bet_placement_phases") > 0
        ELSE false
      END
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
