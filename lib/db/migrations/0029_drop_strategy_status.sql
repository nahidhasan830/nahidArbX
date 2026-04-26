-- Strategies are now either available (retired_at IS NULL) or archived
-- (retired_at IS NOT NULL). The candidate/live/paused/retired enum was tied
-- to the (now-removed) value-detector matching path. "Active" is no longer
-- a strategy state — it's determined by membership in
-- betting_settings.active_strategy_ids.
--
-- Backfill: anything previously marked retired keeps its retired flag via
-- the existing retired_at column (or paused_at as a fallback timestamp).

UPDATE optimization_strategies
   SET retired_at = COALESCE(retired_at, paused_at, updated_at, NOW())
 WHERE status = 'retired'
   AND retired_at IS NULL;

DROP INDEX IF EXISTS optimization_strategies_live_idx;
DROP INDEX IF EXISTS optimization_strategies_status_idx;

ALTER TABLE optimization_strategies DROP COLUMN IF EXISTS status;
ALTER TABLE optimization_strategies DROP COLUMN IF EXISTS activated_at;
ALTER TABLE optimization_strategies DROP COLUMN IF EXISTS paused_at;
