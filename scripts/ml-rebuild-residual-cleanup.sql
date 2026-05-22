-- ml-rebuild-residual-cleanup.sql — narrow cleanup for the post-rebuild legacy tail.
--
-- Removes only the residual v=3 / pre-rebuild rows that the selective Phase 2
-- backfill left behind. Does NOT touch the 4821-row v=1 corpus.
--
-- Run after Phase 5 sign-off and before the first auto-retrain if you want
-- /api/ml/pipeline.featureContract.allVersionsMatch to flip green.
--
-- Idempotent. Wrapped in a transaction so a partial failure rolls back.
-- Compare BEFORE/AFTER counts at the bottom before COMMIT — abort the
-- transaction if the deltas don't match expectations.

BEGIN;

-- ── BEFORE counts ──────────────────────────────────────────────────────────
SELECT 'before:ml_models' AS label, count(*) AS n FROM ml_models;
SELECT 'before:ml_models@fv3' AS label, count(*) AS n
  FROM ml_models WHERE feature_version <> 1;
SELECT 'before:ml_training_examples' AS label, count(*) AS n
  FROM ml_training_examples;
SELECT 'before:ml_training_examples@fv3' AS label, count(*) AS n
  FROM ml_training_examples WHERE feature_version <> 1;
SELECT 'before:bets@fv3-with-features' AS label, count(*) AS n
  FROM bets
  WHERE ml_features IS NOT NULL AND ml_feature_version <> 1;
SELECT 'before:bets@fv1-with-features' AS label, count(*) AS n
  FROM bets
  WHERE ml_features IS NOT NULL AND ml_feature_version = 1;

-- ── 1. Drop the pre-rebuild ml_models ghost(s) ─────────────────────────────
-- Anything not at the current feature_version is a pre-rebuild artifact.
-- The current corpus has not produced any model rows yet, so this targets
-- only the v=0 / status=failed pre-rebuild record(s).
DELETE FROM ml_models WHERE feature_version <> 1;

-- ── 2. Drop legacy ml_training_examples ────────────────────────────────────
-- Loader queries already filter by feature_version=1, so these rows never
-- contribute to training. Removing them just unclutters reporting.
DELETE FROM ml_training_examples WHERE feature_version <> 1;

-- ── 3. Clear ml_features on bets that still carry a v3 contract ────────────
-- Pending and void bets at fv=3 will not be revived; the one settled
-- irreconstructible row also can't be backfilled (missing soft snapshot).
-- Clearing the columns leaves the bet itself intact.
UPDATE bets
SET ml_features = NULL,
    ml_feature_version = NULL,
    ml_feature_count = NULL,
    ml_feature_names_hash = NULL,
    ml_score = NULL,
    ml_stake_fraction = NULL
WHERE ml_features IS NOT NULL
  AND ml_feature_version <> 1;

-- ── AFTER counts ───────────────────────────────────────────────────────────
SELECT 'after:ml_models' AS label, count(*) AS n FROM ml_models;
SELECT 'after:ml_training_examples' AS label, count(*) AS n
  FROM ml_training_examples;
SELECT 'after:ml_training_examples@fv1' AS label, count(*) AS n
  FROM ml_training_examples WHERE feature_version = 1;
SELECT 'after:bets@fv1-with-features' AS label, count(*) AS n
  FROM bets
  WHERE ml_features IS NOT NULL AND ml_feature_version = 1;
SELECT 'after:bets@any-with-features' AS label, count(*) AS n
  FROM bets WHERE ml_features IS NOT NULL;

-- Expected after on the current DB:
--   ml_models                          → 0
--   ml_training_examples               → 4821 (all fv=1)
--   ml_training_examples@fv1           → 4821
--   bets@fv1-with-features             → 4821 (unchanged — corpus protected)
--   bets@any-with-features             → 4821 (was 4866; -45 v=3 cleared)

-- Inspect the SELECTs above. Replace the next line with `COMMIT;` only if
-- the AFTER counts match what you expect. Default is ROLLBACK so a copy/paste
-- run is safe.
ROLLBACK;
-- COMMIT;
