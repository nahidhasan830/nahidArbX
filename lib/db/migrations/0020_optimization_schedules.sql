-- AlphaSearch Phase 2 — recurring optimization runs.
--
-- A schedule is a saved configuration that the optimizer scheduler tick
-- fires on its own cadence (e.g. "every day at 03:00"). Each
-- fire creates a fresh row in optimization_runs with the schedule's
-- snapshot (search_space, cv_strategy, data_filters, etc.).
--
-- `frequency` is JSONB with one of these shapes (no free-form cron string
-- in v1 — preset list keeps the UI honest for non-technical operators):
--   { "kind": "every_n_hours", "hours": 1|2|4|6|12 }
--   { "kind": "daily",         "hourLocal": 0..23 }
--   { "kind": "weekly",        "dayOfWeek": 0..6, "hourLocal": 0..23 }
--
-- The Next.js scheduler tick polls
--   WHERE enabled AND next_fire_at <= now()
-- so `next_fire_at` must always be the absolute next UTC fire instant.

CREATE TABLE IF NOT EXISTS "optimization_schedules" (
  "id"                 text PRIMARY KEY NOT NULL,
  "name"               text NOT NULL,
  "description"        text,
  "enabled"            boolean NOT NULL DEFAULT true,
  "timezone"           text NOT NULL DEFAULT 'local',
  "frequency"          jsonb NOT NULL,
  "n_trials_target"    integer NOT NULL DEFAULT 2000,
  "search_algorithm"   text NOT NULL DEFAULT 'ensemble',
  "search_space"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "cv_strategy"        jsonb NOT NULL,
  "data_filters"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "notify_on_complete" boolean NOT NULL DEFAULT false,
  "last_fire_at"       timestamp with time zone,
  "last_run_id"        text,
  "next_fire_at"       timestamp with time zone NOT NULL,
  "created_by"         text,
  "created_at"         timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"         timestamp with time zone DEFAULT now() NOT NULL
);

-- Hot path for the scheduler tick.
CREATE INDEX IF NOT EXISTS "optimization_schedules_due_idx"
  ON "optimization_schedules" ("next_fire_at")
  WHERE "enabled" = true;
CREATE INDEX IF NOT EXISTS "optimization_schedules_created_idx"
  ON "optimization_schedules" ("created_at" DESC);
