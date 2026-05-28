CREATE TABLE IF NOT EXISTS "ml_learning_snapshots" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "snapshot_hash" text NOT NULL,
  "model_version" integer,
  "verdict" text NOT NULL,
  "verdict_reason" text NOT NULL,
  "trigger" text DEFAULT 'manual' NOT NULL,
  "data_as_of" timestamp with time zone NOT NULL,
  "settled_prediction_count" integer NOT NULL,
  "pending_prediction_count" integer NOT NULL,
  "scored_prediction_count" integer NOT NULL,
  "baseline_roi_pct" numeric(14, 4),
  "simple_roi_pct" numeric(14, 4),
  "ml_gate_roi_pct" numeric(14, 4),
  "roi_lift_pct" numeric(14, 4),
  "calibration_error" numeric(8, 6),
  "brier_score" numeric(8, 6),
  "log_loss" numeric(8, 6),
  "auc_roc" numeric(8, 6),
  "score_monotonicity" numeric(6, 4),
  "metrics" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ml_learning_snapshots_snapshot_hash_unique" UNIQUE ("snapshot_hash")
);

CREATE INDEX IF NOT EXISTS "ml_learning_snapshots_created_idx"
  ON "ml_learning_snapshots" ("created_at" DESC);

CREATE INDEX IF NOT EXISTS "ml_learning_snapshots_model_idx"
  ON "ml_learning_snapshots" ("model_version", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "ml_learning_snapshots_verdict_idx"
  ON "ml_learning_snapshots" ("verdict", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "ml_learning_explanations" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "snapshot_hash" text NOT NULL,
  "explanation_type" text DEFAULT 'operator' NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "status" text DEFAULT 'success' NOT NULL,
  "summary" text,
  "content" jsonb NOT NULL,
  "prompt_hash" text NOT NULL,
  "generated_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ml_learning_explanations_unique" UNIQUE (
    "snapshot_hash",
    "explanation_type",
    "model"
  )
);

CREATE INDEX IF NOT EXISTS "ml_learning_explanations_snapshot_idx"
  ON "ml_learning_explanations" ("snapshot_hash");

CREATE INDEX IF NOT EXISTS "ml_learning_explanations_created_idx"
  ON "ml_learning_explanations" ("created_at" DESC);
