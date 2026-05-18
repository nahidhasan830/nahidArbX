-- Drop ml_scheduler_settings — scheduling is removed.
--
-- Auto-retraining now triggers solely when the canonical training
-- corpus has grown by +`ML_RETRAIN_GROWTH_STEP` new examples since the
-- last deployed model (defined in `lib/shared/constants.ts`).
-- Manual retraining is still available via POST /api/ml/retrain.
--
-- Idempotent: safe to re-run.

DROP TABLE IF EXISTS "ml_scheduler_settings";
