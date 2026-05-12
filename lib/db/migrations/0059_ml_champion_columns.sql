-- 0059: Champion/challenger model columns.
--
-- The scorer and ML dashboard use these fields to distinguish the current
-- live model from validated challengers. Keep this migration idempotent so
-- local and Cloud SQL environments can be brought back into sync safely.

ALTER TABLE "ml_models"
  ADD COLUMN IF NOT EXISTS "is_champion" boolean DEFAULT false;

ALTER TABLE "ml_models"
  ADD COLUMN IF NOT EXISTS "champion_to_at" timestamptz;

ALTER TABLE "ml_models"
  ADD COLUMN IF NOT EXISTS "champion_replaced_version" integer;

ALTER TABLE "ml_models"
  ADD COLUMN IF NOT EXISTS "champion_psr" numeric(6, 4);

ALTER TABLE "ml_models"
  ADD COLUMN IF NOT EXISTS "champion_roi_vs_prev" numeric(14, 4);

-- Backfill the newest deployed model as champion when the column is new.
UPDATE "ml_models"
SET
  "is_champion" = true,
  "champion_to_at" = COALESCE("deployed_at", "created_at")
WHERE "id" = (
  SELECT "id"
  FROM "ml_models"
  WHERE "status" = 'deployed'
  ORDER BY "deployed_at" DESC NULLS LAST, "version" DESC
  LIMIT 1
)
AND NOT EXISTS (
  SELECT 1
  FROM "ml_models"
  WHERE "is_champion" = true
);

CREATE INDEX IF NOT EXISTS "ml_models_champion_idx"
  ON "ml_models" ("is_champion")
  WHERE "is_champion" = true;
