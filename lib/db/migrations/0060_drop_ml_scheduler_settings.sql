-- Drop ml_scheduler_settings — scheduling is removed.
--
-- Auto-retraining now triggers solely when the canonical training
-- corpus has grown ≥20% since the last deployed model. The threshold
-- lives in `lib/shared/constants.ts` (ML_RETRAIN_GROWTH_THRESHOLD).
-- Manual retraining is still available via POST /api/ml/retrain.
--
-- Idempotent: safe to re-run.

DROP TABLE IF EXISTS "ml_scheduler_settings";
