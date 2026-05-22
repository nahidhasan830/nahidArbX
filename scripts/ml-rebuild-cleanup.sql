-- ML rebuild cleanup — wipe training state for a clean current-contract rebuild. No backups, starting fresh.
BEGIN;

DELETE FROM ml_models;
DELETE FROM ml_training_examples;

UPDATE bets
SET ml_features = NULL,
    ml_feature_version = NULL,
    ml_feature_count = NULL,
    ml_feature_names_hash = NULL,
    ml_score = NULL,
    ml_stake_fraction = NULL
WHERE ml_features IS NOT NULL
   OR ml_feature_version IS NOT NULL
   OR ml_feature_count IS NOT NULL
   OR ml_feature_names_hash IS NOT NULL
   OR ml_score IS NOT NULL
   OR ml_stake_fraction IS NOT NULL;

ALTER SEQUENCE ml_model_version_seq RESTART WITH 1;

SELECT
  (SELECT count(*) FROM ml_models) AS models_count,
  (SELECT count(*) FROM ml_training_examples) AS examples_count,
  (SELECT count(*) FROM bets WHERE ml_features IS NOT NULL) AS bets_with_features_count;
-- Expected: 0 | 0 | 0

COMMIT;
