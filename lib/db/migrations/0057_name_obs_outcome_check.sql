-- Widen the CHECK constraint on name_observations.outcome to include
-- auto-resolver decisions (auto-confirm, auto-reject). The original
-- constraint (0031_entities.sql) only allowed harvester/operator outcomes
-- and pre-dated the auto-resolver pipeline added in auto-resolve.ts.
ALTER TABLE name_observations
  DROP CONSTRAINT IF EXISTS name_observations_outcome_check;

ALTER TABLE name_observations
  ADD CONSTRAINT name_observations_outcome_check
  CHECK (outcome IN (
    'matched',
    'rejected',
    'near-match',
    'manual-confirm',
    'manual-reject',
    'auto-confirm',
    'auto-reject'
  ));
