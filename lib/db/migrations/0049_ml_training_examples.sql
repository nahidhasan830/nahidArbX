-- Phase 4: ML Training Examples table + schema alignment fixes.
-- Adds the ml_training_examples table for decoupled ML training data.
-- Columns ml_feature_version, ml_feature_count, ml_feature_names_hash on bets
-- and feature_version, feature_names_hash on ml_models were already added
-- by migration 0046 via ALTER TABLE; this migration only creates the new table.

CREATE TABLE IF NOT EXISTS "ml_training_examples" (
	"id" bigserial PRIMARY KEY,
	"source_bet_id" text,
	"example_type" text NOT NULL,
	"event_id" text NOT NULL,
	"family_id" text NOT NULL,
	"atom_id" text NOT NULL,
	"features" real[],
	"feature_version" integer NOT NULL DEFAULT 2,
	"label" text,
	"label_source" text,
	"sample_weight" real NOT NULL DEFAULT 1.0,
	"outcome" text,
	"pnl" numeric(10, 2),
	"clv_pct" numeric(6, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
-->statement-breakpoint
CREATE INDEX IF NOT EXISTS "ml_training_examples_type_idx" ON "ml_training_examples" ("example_type");
-->statement-breakpoint
CREATE INDEX IF NOT EXISTS "ml_training_examples_bet_idx" ON "ml_training_examples" ("source_bet_id");
-->statement-breakpoint
CREATE INDEX IF NOT EXISTS "ml_training_examples_version_idx" ON "ml_training_examples" ("feature_version");
-->statement-breakpoint
CREATE INDEX IF NOT EXISTS "ml_training_examples_settled_idx" ON "ml_training_examples" ("settled_at" DESC) WHERE "settled_at" IS NOT NULL;
