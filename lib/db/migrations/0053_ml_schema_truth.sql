-- Phase 1: Schema & Migration Truth
--
-- This migration enforces the contracts that the code already assumes:
--   1. ml_models.onnx_blob bytea column (idempotent)
--   2. ml_models.notified_at for restart-safe notification idempotency
--   3. ml_model_version_seq for race-safe version allocation
--   4. Dedupe ml_training_examples shadow_scored duplicates
--   5. Unique indexes on ml_training_examples
--   6. CHECK constraints on ML enum columns
--   7. Singleton CHECK on ml_scheduler_settings

-- ══════════════════════════════════════════════════════════════════════
-- 1. ml_models.onnx_blob — exists in live DB (Phase 0 confirmed) but
--    no migration tracked it. Add idempotently.
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE "ml_models" ADD COLUMN IF NOT EXISTS "onnx_blob" bytea;

-- ══════════════════════════════════════════════════════════════════════
-- 2. ml_models.notified_at — replaces the in-memory notifiedIds Set.
--    Persists across engine restarts so deployed-model notifications
--    are never duplicated.
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE "ml_models" ADD COLUMN IF NOT EXISTS "notified_at" timestamptz;

-- Stamp existing deployed models that were already notified historically.
UPDATE "ml_models"
SET "notified_at" = COALESCE("deployed_at", "created_at")
WHERE "status" IN ('deployed', 'retired')
  AND "notified_at" IS NULL;

-- ══════════════════════════════════════════════════════════════════════
-- 3. ml_model_version_seq — Postgres sequence for race-safe version
--    allocation. Replaces MAX(version)+1 in Python exporter.
-- ══════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  -- Create sequence starting from max existing version + 1
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ml_model_version_seq') THEN
    EXECUTE format(
      'CREATE SEQUENCE ml_model_version_seq START WITH %s',
      COALESCE((SELECT MAX(version) + 1 FROM ml_models), 1)
    );
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════
-- 4. Dedupe ml_training_examples — remove duplicate shadow_scored rows.
--    Phase 0 found 202 duplicate groups (all shadow_scored). Keep the
--    latest row per (source_bet_id, example_type) group.
-- ══════════════════════════════════════════════════════════════════════
DELETE FROM "ml_training_examples"
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id",
           ROW_NUMBER() OVER (
             PARTITION BY "source_bet_id", "example_type"
             ORDER BY
               -- Prefer labeled over unlabeled
               CASE WHEN "label" IS NOT NULL THEN 0 ELSE 1 END,
               -- Prefer settled over unsettled
               CASE WHEN "settled_at" IS NOT NULL THEN 0 ELSE 1 END,
               -- Among equals, keep newest
               "id" DESC
           ) AS rn
    FROM "ml_training_examples"
    WHERE "source_bet_id" IS NOT NULL
  ) ranked
  WHERE rn > 1
);

-- Also dedupe null-source rows by (event_id, family_id, atom_id, example_type)
DELETE FROM "ml_training_examples"
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id",
           ROW_NUMBER() OVER (
             PARTITION BY "event_id", "family_id", "atom_id", "example_type"
             ORDER BY
               CASE WHEN "label" IS NOT NULL THEN 0 ELSE 1 END,
               CASE WHEN "settled_at" IS NOT NULL THEN 0 ELSE 1 END,
               "id" DESC
           ) AS rn
    FROM "ml_training_examples"
    WHERE "source_bet_id" IS NULL
  ) ranked
  WHERE rn > 1
);

-- ══════════════════════════════════════════════════════════════════════
-- 5. Unique indexes on ml_training_examples — enforce one row per
--    semantic key so onConflictDoNothing and onConflictDoUpdate work.
-- ══════════════════════════════════════════════════════════════════════
CREATE UNIQUE INDEX IF NOT EXISTS "ml_training_examples_bet_type_uq"
  ON "ml_training_examples" ("source_bet_id", "example_type")
  WHERE "source_bet_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "ml_training_examples_selection_type_uq"
  ON "ml_training_examples" ("event_id", "family_id", "atom_id", "example_type")
  WHERE "source_bet_id" IS NULL;

-- ══════════════════════════════════════════════════════════════════════
-- 6. CHECK constraints on ML enum columns.
--    Only added where existing data is 100% conformant (Phase 0 verified).
-- ══════════════════════════════════════════════════════════════════════

-- ml_models.status
DO $$ BEGIN
  ALTER TABLE "ml_models"
    ADD CONSTRAINT "ml_models_status_check"
    CHECK ("status" IN ('training', 'validated', 'deployed', 'retired', 'rejected', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ml_models.permission_level
DO $$ BEGIN
  ALTER TABLE "ml_models"
    ADD CONSTRAINT "ml_models_permission_level_check"
    CHECK ("permission_level" IS NULL OR "permission_level" IN ('shadow', 'gate_only', 'stake_reduce', 'stake_increase'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ml_training_examples.example_type
DO $$ BEGIN
  ALTER TABLE "ml_training_examples"
    ADD CONSTRAINT "ml_training_examples_type_check"
    CHECK ("example_type" IN ('settled_detected', 'placed_settled', 'near_miss', 'shadow_scored'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ml_training_examples.label
DO $$ BEGIN
  ALTER TABLE "ml_training_examples"
    ADD CONSTRAINT "ml_training_examples_label_check"
    CHECK ("label" IS NULL OR "label" IN ('positive', 'negative'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ml_training_examples.label_source
DO $$ BEGIN
  ALTER TABLE "ml_training_examples"
    ADD CONSTRAINT "ml_training_examples_label_source_check"
    CHECK ("label_source" IS NULL OR "label_source" IN ('outcome', 'clv', 'near_miss'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ml_training_examples.outcome
DO $$ BEGIN
  ALTER TABLE "ml_training_examples"
    ADD CONSTRAINT "ml_training_examples_outcome_check"
    CHECK ("outcome" IS NULL OR "outcome" IN ('won', 'lost', 'half_won', 'half_lost', 'void'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ══════════════════════════════════════════════════════════════════════
-- 7. Singleton CHECK on ml_scheduler_settings (id must be 'default').
-- ══════════════════════════════════════════════════════════════════════
DO $$ BEGIN
  ALTER TABLE "ml_scheduler_settings"
    ADD CONSTRAINT "ml_scheduler_settings_singleton_check"
    CHECK ("id" = 'default');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
