-- AlphaSearch Phase 3 — promoted live strategies + bets attribution.
--
-- A strategy is a saved configuration (filters + sizing) that the
-- value-detector consults on every tick. Matching bets get tagged with
-- strategy_id; the strategy's sizing overrides global Kelly settings.
--
-- Lifecycle: candidate → live → paused → retired.

CREATE TABLE IF NOT EXISTS "optimization_strategies" (
  "id"               text PRIMARY KEY NOT NULL,
  "name"             text NOT NULL,
  "description"      text,
  "source"           text NOT NULL DEFAULT 'optimizer',
  "source_run_id"    text,
  "source_trial_id"  text,
  "filters"          jsonb NOT NULL,
  "sizing"           jsonb NOT NULL,
  "status"           text NOT NULL DEFAULT 'candidate',
  "metrics_snapshot" jsonb NOT NULL,
  "live_metrics"     jsonb,
  "activated_at"     timestamp with time zone,
  "paused_at"        timestamp with time zone,
  "retired_at"       timestamp with time zone,
  "created_by"       text,
  "created_at"       timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"       timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "optimization_strategies_status_idx"
  ON "optimization_strategies" ("status");
CREATE INDEX IF NOT EXISTS "optimization_strategies_live_idx"
  ON "optimization_strategies" ("id") WHERE "status" = 'live';
CREATE INDEX IF NOT EXISTS "optimization_strategies_created_idx"
  ON "optimization_strategies" ("created_at" DESC);

-- Bets attribution: which live strategy claimed this detection.
ALTER TABLE "bets"
  ADD COLUMN IF NOT EXISTS "strategy_id" text;

CREATE INDEX IF NOT EXISTS "bets_strategy_idx"
  ON "bets" ("strategy_id") WHERE "strategy_id" IS NOT NULL;
