-- Strategy attribution moves to a pure-query model: live ROI is computed by
-- re-applying the strategy's filters to the bets table at read time, not by
-- tagging individual bets. Drops the sparse index first (Postgres requires
-- the index to go before the column it covers).
DROP INDEX IF EXISTS bets_strategy_idx;
ALTER TABLE bets DROP COLUMN IF EXISTS strategy_id;
