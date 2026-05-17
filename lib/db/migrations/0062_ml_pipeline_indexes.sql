-- ML pipeline performance indexes. Every 15s the pipeline scans the bets
-- table multiple times with filters on ml_feature_version, ml_feature_names_hash,
-- and ml_score. Without indexes these are full sequential scans on every poll.

-- Composite index for the common pipeline WHERE clause pattern:
--   ml_feature_version = N AND ml_feature_names_hash = H
-- Includes ml_score so queries that also filter on it can do Index Only Scans.
CREATE INDEX IF NOT EXISTS bets_ml_feature_version_idx
  ON bets (ml_feature_version, ml_feature_names_hash, ml_score);

-- Coverage query: SELECT COUNT(DISTINCT competition) FROM bets
CREATE INDEX IF NOT EXISTS bets_competition_idx
  ON bets (competition)
  WHERE competition IS NOT NULL;
