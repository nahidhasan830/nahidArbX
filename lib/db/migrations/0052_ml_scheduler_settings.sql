-- ML Scheduler Settings — persistent scheduler configuration.
-- Allows the operator to configure automated retraining cadence,
-- minimum example thresholds, and enable/disable via the UI.
--
-- Single-row config table (id = 'default').

CREATE TABLE IF NOT EXISTS "ml_scheduler_settings" (
  "id"                      text PRIMARY KEY DEFAULT 'default',
  "enabled"                 boolean NOT NULL DEFAULT true,
  "cadence_hours"           integer NOT NULL DEFAULT 24,
  "min_new_settled_examples" integer NOT NULL DEFAULT 50,
  "min_growth_pct"          integer NOT NULL DEFAULT 20,
  "next_run_at"             timestamptz,
  "last_run_at"             timestamptz,
  "last_error"              text,
  "updated_at"              timestamptz NOT NULL DEFAULT now()
);

-- Seed with defaults if empty.
INSERT INTO "ml_scheduler_settings" ("id")
VALUES ('default')
ON CONFLICT ("id") DO NOTHING;
