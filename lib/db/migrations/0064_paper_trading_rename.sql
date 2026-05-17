-- Paper Trading rename + drop champion/challenger
--
-- 1. Rename bets.ml_kelly_adjusted → bets.ml_stake_fraction
--    (Column stored the model-adjusted stake FRACTION, not a multiplier;
--     the old name was misleading.)
-- 2. Migrate ml_models.permission_level value 'shadow' → 'observe'
--    and update its default + CHECK constraint. 'observe' matches the
--    verb form of the other levels (gate_only, stake_reduce,
--    stake_increase). The CHECK constraint must be relaxed before the
--    UPDATE can run, then tightened with the new allowed set.
-- 3. Drop champion/challenger columns from ml_models. The deployment
--    gate is the only quality bar — a validated model just deploys,
--    replacing the previous deployed model. status = 'deployed'
--    is the single source of truth for "the active model".
--
-- Fully idempotent — safe to re-run after partial application.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'bets'
       AND column_name = 'ml_kelly_adjusted'
  ) THEN
    ALTER TABLE "bets" RENAME COLUMN "ml_kelly_adjusted" TO "ml_stake_fraction";
  END IF;
END $$;
--> statement-breakpoint

-- Drop the old check constraint so we can rewrite the value.
ALTER TABLE "ml_models" DROP CONSTRAINT IF EXISTS "ml_models_permission_level_check";
--> statement-breakpoint

UPDATE "ml_models"
   SET "permission_level" = 'observe'
 WHERE "permission_level" = 'shadow';
--> statement-breakpoint

ALTER TABLE "ml_models"
  ALTER COLUMN "permission_level" SET DEFAULT 'observe';
--> statement-breakpoint

-- Re-add the check constraint with the renamed value set.
ALTER TABLE "ml_models"
  ADD CONSTRAINT "ml_models_permission_level_check"
  CHECK ("permission_level" IS NULL OR "permission_level" IN ('observe', 'gate_only', 'stake_reduce', 'stake_increase'));
--> statement-breakpoint

ALTER TABLE "ml_models" DROP COLUMN IF EXISTS "is_champion";
--> statement-breakpoint
ALTER TABLE "ml_models" DROP COLUMN IF EXISTS "champion_to_at";
--> statement-breakpoint
ALTER TABLE "ml_models" DROP COLUMN IF EXISTS "champion_replaced_version";
--> statement-breakpoint
ALTER TABLE "ml_models" DROP COLUMN IF EXISTS "champion_psr";
--> statement-breakpoint
ALTER TABLE "ml_models" DROP COLUMN IF EXISTS "champion_roi_vs_prev";
