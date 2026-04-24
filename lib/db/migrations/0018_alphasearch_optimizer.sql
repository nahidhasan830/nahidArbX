-- AlphaSearch Phase 1 — parameter-optimization runs + their trials.
--
-- Two tables shared between the Next.js API (writer of `optimization_runs`
-- queue rows + reader of progress/results) and the Python sidecar
-- `services/optimizer/` (writer of every trial + final summary).
--
-- See docs/alphasearch.md and lib/db/schema.ts for column-level docs.

CREATE TABLE IF NOT EXISTS "optimization_runs" (
  "id"               text PRIMARY KEY NOT NULL,
  "name"             text NOT NULL,
  "status"           text NOT NULL DEFAULT 'queued',
  "search_space"     jsonb NOT NULL,
  "search_algorithm" text NOT NULL,
  "n_trials_target"  integer NOT NULL,
  "n_trials_done"    integer NOT NULL DEFAULT 0,
  "rng_seed"         integer NOT NULL,
  "cv_strategy"      jsonb NOT NULL,
  "baseline_metrics" jsonb,
  "summary"          jsonb,
  "best_trial_id"    text,
  "error"            text,
  "started_at"       timestamp with time zone,
  "completed_at"     timestamp with time zone,
  "created_by"       text,
  "created_at"       timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "optimization_runs_status_idx"
  ON "optimization_runs" ("status");
CREATE INDEX IF NOT EXISTS "optimization_runs_created_idx"
  ON "optimization_runs" ("created_at" DESC);
-- Hot path for the Next.js scheduler poll.
CREATE INDEX IF NOT EXISTS "optimization_runs_queued_idx"
  ON "optimization_runs" ("created_at")
  WHERE "status" = 'queued';

CREATE TABLE IF NOT EXISTS "optimization_trials" (
  "id"                    text PRIMARY KEY NOT NULL,
  "run_id"                text NOT NULL REFERENCES "optimization_runs"("id") ON DELETE CASCADE,
  "trial_index"           integer NOT NULL,
  "sampler"               text NOT NULL,
  "params"                jsonb NOT NULL,
  "fold_metrics"          jsonb NOT NULL,
  "oos_roi_mean"          numeric(8, 4),
  "oos_roi_ci_low"        numeric(8, 4),
  "oos_roi_ci_high"       numeric(8, 4),
  "oos_sortino"           numeric(8, 4),
  "oos_sharpe"            numeric(8, 4),
  "deflated_sharpe"       numeric(8, 4),
  "probabilistic_sharpe"  numeric(6, 4),
  "max_drawdown"          numeric(8, 4),
  "sample_size"           integer,
  "composite_score"       numeric(8, 4),
  "on_pareto"             boolean NOT NULL DEFAULT false,
  "created_at"            timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "optimization_trials_run_index_idx"
  ON "optimization_trials" ("run_id", "trial_index");
CREATE INDEX IF NOT EXISTS "optimization_trials_score_idx"
  ON "optimization_trials" ("run_id", "composite_score" DESC);
CREATE INDEX IF NOT EXISTS "optimization_trials_pareto_idx"
  ON "optimization_trials" ("run_id")
  WHERE "on_pareto" = true;
