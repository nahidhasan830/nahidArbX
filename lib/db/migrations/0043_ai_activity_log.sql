CREATE TABLE IF NOT EXISTS "ai_activity_log" (
  "id" bigserial PRIMARY KEY,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "system" text NOT NULL,
  "trigger" text DEFAULT 'manual' NOT NULL,
  "status" text NOT NULL,
  "model" text,
  "item_count" integer,
  "duration_ms" integer,
  "cost_usd" numeric(8, 5),
  "summary" text,
  "error" text,
  "metadata" jsonb
);

CREATE INDEX IF NOT EXISTS "ai_activity_log_created_idx" ON "ai_activity_log" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "ai_activity_log_system_idx" ON "ai_activity_log" ("system");
CREATE INDEX IF NOT EXISTS "ai_activity_log_status_idx" ON "ai_activity_log" ("status");
