CREATE TABLE IF NOT EXISTS "event_matcher_run_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "trigger" text NOT NULL,
  "mode" text DEFAULT 'apply' NOT NULL,
  "decision_ids" jsonb NOT NULL,
  "use_deepseek" boolean,
  "summary" jsonb,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "event_matcher_run_jobs_status_idx"
  ON "event_matcher_run_jobs" ("status");
CREATE INDEX IF NOT EXISTS "event_matcher_run_jobs_created_idx"
  ON "event_matcher_run_jobs" ("created_at" DESC);

CREATE TABLE IF NOT EXISTS "event_matcher_run_job_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "job_id" text NOT NULL,
  "phase" text NOT NULL,
  "event" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "event_matcher_run_job_events_job_idx"
  ON "event_matcher_run_job_events" ("job_id");
CREATE INDEX IF NOT EXISTS "event_matcher_run_job_events_created_idx"
  ON "event_matcher_run_job_events" ("created_at");

ALTER TABLE "event_matcher_run_job_events"
  ADD CONSTRAINT "event_matcher_run_job_events_job_fk"
  FOREIGN KEY ("job_id")
  REFERENCES "event_matcher_run_jobs" ("id")
  ON DELETE CASCADE;
