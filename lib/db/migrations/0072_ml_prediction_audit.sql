CREATE TABLE IF NOT EXISTS "ml_prediction_audit" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "prediction_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "scored_at" timestamp with time zone NOT NULL,
  "bet_id" text NOT NULL,
  "event_id" text NOT NULL,
  "family_id" text NOT NULL,
  "atom_id" text NOT NULL,
  "atom_label" text NOT NULL,
  "home_team" text NOT NULL,
  "away_team" text NOT NULL,
  "competition" text,
  "event_start_time" timestamp with time zone NOT NULL,
  "market_type" text NOT NULL,
  "time_scope" text NOT NULL,
  "family_line" numeric(5, 2),
  "soft_provider" text NOT NULL,
  "soft_odds" numeric(10, 4) NOT NULL,
  "soft_commission_pct" numeric(5, 2) NOT NULL,
  "sharp_provider" text NOT NULL,
  "sharp_odds" numeric(10, 4) NOT NULL,
  "sharp_true_prob" numeric(6, 5) NOT NULL,
  "baseline_ev_pct" numeric(8, 3),
  "baseline_kelly_fraction" real,
  "model_version" integer,
  "ml_score" real NOT NULL,
  "model_edge_pct" numeric(8, 3),
  "kelly_multiplier" real,
  "ml_stake_fraction" real,
  "decision" text NOT NULL,
  "permission_level" text NOT NULL,
  "ml_features" real[],
  "ml_feature_version" integer NOT NULL,
  "ml_feature_count" integer NOT NULL,
  "ml_feature_names_hash" text NOT NULL,
  "outcome" text DEFAULT 'pending' NOT NULL,
  "pnl" numeric(10, 2),
  "clv_pct" numeric(6, 2),
  "settled_at" timestamp with time zone,
  CONSTRAINT "ml_prediction_audit_prediction_key_unique" UNIQUE ("prediction_key")
);

CREATE INDEX IF NOT EXISTS "ml_prediction_audit_scored_idx"
  ON "ml_prediction_audit" ("scored_at" DESC);

CREATE INDEX IF NOT EXISTS "ml_prediction_audit_bet_idx"
  ON "ml_prediction_audit" ("bet_id");

CREATE INDEX IF NOT EXISTS "ml_prediction_audit_model_idx"
  ON "ml_prediction_audit" ("model_version", "scored_at" DESC);

CREATE INDEX IF NOT EXISTS "ml_prediction_audit_decision_idx"
  ON "ml_prediction_audit" ("decision", "scored_at" DESC);

CREATE INDEX IF NOT EXISTS "ml_prediction_audit_market_idx"
  ON "ml_prediction_audit" ("market_type", "scored_at" DESC);

CREATE INDEX IF NOT EXISTS "ml_prediction_audit_event_start_idx"
  ON "ml_prediction_audit" ("event_start_time" DESC);

CREATE INDEX IF NOT EXISTS "ml_prediction_audit_outcome_idx"
  ON "ml_prediction_audit" ("outcome", "scored_at" DESC);
