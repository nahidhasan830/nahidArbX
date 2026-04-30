-- Bets table schema pruning — drop 8 decommissioned columns in two phases.
--
-- Phase 1 (from the value_bets→bets merge cleanup):
--   error            — dead column, zero writes in codebase
--   created_at       — redundant with first_seen_at (always set to same value)
--   updated_at       — never queried; last_seen_at / settled_at / placed_at serve
--   outcome_marked_at — merged into settled_at (all outcome resolution = settlement)
--
-- Phase 2 (reactive odds engine alignment):
--   request_payload  — debug blob (2-5 KB/row), never queried programmatically
--   response_payload — debug blob (2-5 KB/row), never queried programmatically
--   sharp_odds_age_ms — staleness enforced at runtime (180s gate), no DB consumer
--   closing_soft_odds — CLV analysis uses closing_sharp_odds exclusively

-- Phase 1
ALTER TABLE bets DROP COLUMN IF EXISTS error;
ALTER TABLE bets DROP COLUMN IF EXISTS created_at;
ALTER TABLE bets DROP COLUMN IF EXISTS updated_at;
ALTER TABLE bets DROP COLUMN IF EXISTS outcome_marked_at;

-- Phase 2
ALTER TABLE bets DROP COLUMN IF EXISTS request_payload;
ALTER TABLE bets DROP COLUMN IF EXISTS response_payload;
ALTER TABLE bets DROP COLUMN IF EXISTS sharp_odds_age_ms;
ALTER TABLE bets DROP COLUMN IF EXISTS closing_soft_odds;
