-- Phase 7: Model Deployment Gate
-- Adds permission_level and rejection_reasons to ml_models for the deployment gate.

ALTER TABLE "ml_models" ADD COLUMN IF NOT EXISTS "permission_level" text DEFAULT 'shadow';-->statement-breakpoint
ALTER TABLE "ml_models" ADD COLUMN IF NOT EXISTS "rejection_reasons" jsonb;
