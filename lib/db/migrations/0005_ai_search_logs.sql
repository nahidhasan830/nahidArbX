CREATE TABLE IF NOT EXISTS "ai_search_logs" (
  "id" bigserial PRIMARY KEY,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "endpoint" text NOT NULL,
  "service" text DEFAULT 'Manual' NOT NULL,
  "status" text NOT NULL,
  "provider_used" text,
  "model_used" text,
  "query" text,
  "duration_ms" integer,
  "result_count" integer,
  "error" text,
  "request_body" jsonb,
  "response_summary" jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_search_logs_created_idx" ON "ai_search_logs" ("created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_search_logs_status_idx" ON "ai_search_logs" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_search_logs_service_idx" ON "ai_search_logs" ("service");