-- Phase 6: Drop shadow_decisions table.
-- Shadow analytics are now derived on-the-fly from bets WHERE ml_score IS NOT NULL.
-- The shadow_decisions table was a redundant copy of data already stored in bets.

DROP TABLE IF EXISTS shadow_decisions;
