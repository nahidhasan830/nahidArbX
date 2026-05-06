-- Drop legacy AlphaSearch optimizer tables.
-- These tables were used by the old parameter-sweep optimizer (Optuna/TPE/NSGA-II)
-- and are no longer referenced by any Drizzle schema or application code.
-- The ML pipeline (LightGBM) uses ml_models + ml_training_examples instead.
--
-- Idempotent: DROP IF EXISTS — safe to re-run.

-- optimization_trials references optimization_runs, so drop it first.
DROP TABLE IF EXISTS "optimization_trials" CASCADE;
DROP TABLE IF EXISTS "optimization_runs" CASCADE;
DROP TABLE IF EXISTS "optimization_schedules" CASCADE;
DROP TABLE IF EXISTS "optimization_strategies" CASCADE;
