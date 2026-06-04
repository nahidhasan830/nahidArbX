ALTER TABLE "bets"
  ADD COLUMN IF NOT EXISTS "placed_ml_score" real,
  ADD COLUMN IF NOT EXISTS "placed_ml_model_edge_pct" numeric(8, 3),
  ADD COLUMN IF NOT EXISTS "placed_ml_decision" text,
  ADD COLUMN IF NOT EXISTS "placed_ml_kelly_multiplier" real,
  ADD COLUMN IF NOT EXISTS "placed_ml_model_version" integer,
  ADD COLUMN IF NOT EXISTS "placed_ml_features" real[],
  ADD COLUMN IF NOT EXISTS "placed_ml_feature_version" integer,
  ADD COLUMN IF NOT EXISTS "placed_ml_feature_count" integer,
  ADD COLUMN IF NOT EXISTS "placed_ml_feature_names_hash" text;

CREATE INDEX IF NOT EXISTS "bets_placed_ml_decision_idx"
  ON "bets" ("placed_ml_decision", "placed_at" DESC)
  WHERE "placed_at" IS NOT NULL AND "placed_ml_decision" IS NOT NULL;

ALTER TABLE "auto_placer_log"
  ADD COLUMN IF NOT EXISTS "ml_model_edge_pct" numeric(8, 3),
  ADD COLUMN IF NOT EXISTS "ml_decision" text,
  ADD COLUMN IF NOT EXISTS "ml_kelly_multiplier" real;
