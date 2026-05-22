-- Phase 1: reset ML persisted defaults to the clean rebuild contract.
-- Existing rows are left untouched; this only changes defaults for new writes.

ALTER TABLE "ml_models"
  ALTER COLUMN "feature_count" SET DEFAULT 22;
--> statement-breakpoint
ALTER TABLE "ml_models"
  ALTER COLUMN "feature_version" SET DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "ml_training_examples"
  ALTER COLUMN "feature_version" SET DEFAULT 1;
--> statement-breakpoint
