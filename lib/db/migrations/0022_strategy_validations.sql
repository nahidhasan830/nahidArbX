-- AlphaSearch periodic strategy re-validation + drift-based auto-pause.
--
-- One row per validation run per strategy. The auto-validator fires every
-- ~7 days and writes one row per live strategy. Three consecutive
-- drift_flag=true checks → strategy auto-paused (its row's
-- triggered_auto_pause is set to true with a note).

CREATE TABLE IF NOT EXISTS "strategy_validations" (
  "id"                     text PRIMARY KEY NOT NULL,
  "strategy_id"            text NOT NULL REFERENCES "optimization_strategies"("id") ON DELETE CASCADE,
  "ran_at"                 timestamp with time zone DEFAULT now() NOT NULL,
  "n_settled"              integer NOT NULL DEFAULT 0,
  "live_roi_pct"           numeric(8, 4),
  "snapshot_roi_mean"      numeric(8, 4),
  "snapshot_roi_ci_low"    numeric(8, 4),
  "snapshot_roi_ci_high"   numeric(8, 4),
  "drift_flag"             boolean NOT NULL DEFAULT false,
  "consecutive_drifts"     integer NOT NULL DEFAULT 0,
  "triggered_auto_pause"   boolean NOT NULL DEFAULT false,
  "note"                   text
);

CREATE INDEX IF NOT EXISTS "strategy_validations_strategy_idx"
  ON "strategy_validations" ("strategy_id", "ran_at" DESC);
CREATE INDEX IF NOT EXISTS "strategy_validations_ran_idx"
  ON "strategy_validations" ("ran_at" DESC);
