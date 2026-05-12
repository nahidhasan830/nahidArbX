-- 0058: Purge near_miss training examples and tighten constraints.
--
-- near_miss collection was decommissioned because simulations showed 524
-- fabricated negative labels inflated the negative training class by 40.1%,
-- distorting the ML model's decision boundary. All code paths that created
-- or consumed near_miss rows have been removed. This migration cleans up
-- the database.

-- 1. Delete all near_miss training examples
DELETE FROM ml_training_examples WHERE example_type = 'near_miss';

-- 2. Drop the old CHECK constraint and replace with one that excludes near_miss.
--    The CHECK was added in 0053_ml_schema_truth.sql.
ALTER TABLE ml_training_examples
  DROP CONSTRAINT IF EXISTS ml_training_examples_example_type_check;

ALTER TABLE ml_training_examples
  ADD CONSTRAINT ml_training_examples_example_type_check
  CHECK (example_type IN ('settled_detected', 'placed_settled', 'shadow_scored'));

-- 3. Also tighten label_source (remove 'near_miss' as a valid label_source)
ALTER TABLE ml_training_examples
  DROP CONSTRAINT IF EXISTS ml_training_examples_label_source_check;

ALTER TABLE ml_training_examples
  ADD CONSTRAINT ml_training_examples_label_source_check
  CHECK (label_source IS NULL OR label_source IN ('outcome', 'clv'));
