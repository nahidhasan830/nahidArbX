-- Vertex deployment metadata for ML model audit trail.
--
-- The optimizer exporter writes the Vertex AI Model Registry resource name
-- and Prediction Endpoint resource name into ml_models after deployment.

ALTER TABLE "ml_models"
  ADD COLUMN IF NOT EXISTS "vertex_model_name" text;
--> statement-breakpoint
ALTER TABLE "ml_models"
  ADD COLUMN IF NOT EXISTS "vertex_endpoint_name" text;
--> statement-breakpoint
