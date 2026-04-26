-- Matcher scheduler configuration + run history.
-- Config is stored in Postgres so the ML server (entity-matcher)
-- reads it directly and the Next.js UI is just a config editor.

CREATE TABLE IF NOT EXISTS matcher_config (
  id            text PRIMARY KEY DEFAULT 'default',
  enabled       boolean NOT NULL DEFAULT false,
  interval_ms   integer NOT NULL DEFAULT 60000,

  -- Scoring thresholds (bi-encoder)
  team_merge_threshold     real NOT NULL DEFAULT 0.9,
  comp_merge_threshold     real NOT NULL DEFAULT 0.75,
  team_reject_threshold    real NOT NULL DEFAULT 0.5,
  combined_merge_threshold real NOT NULL DEFAULT 0.88,
  combined_reject_threshold real NOT NULL DEFAULT 0.5,

  -- Cross-encoder escalation
  xe_escalation_enabled    boolean NOT NULL DEFAULT true,
  xe_escalation_low        real NOT NULL DEFAULT 0.7,
  xe_escalation_high       real NOT NULL DEFAULT 0.89,
  xe_merge_threshold       real NOT NULL DEFAULT 0.9,
  xe_pvalue_threshold      real NOT NULL DEFAULT 0.05,

  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Seed the singleton row
INSERT INTO matcher_config (id) VALUES ('default') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS matcher_runs (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  duration_ms   integer,
  processed     integer NOT NULL DEFAULT 0,
  merged        integer NOT NULL DEFAULT 0,
  rejected      integer NOT NULL DEFAULT 0,
  escalated     integer NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'running',  -- running | success | empty | service_error
  trigger       text NOT NULL DEFAULT 'scheduler', -- scheduler | manual
  error_message text
);

CREATE INDEX IF NOT EXISTS matcher_runs_started_idx ON matcher_runs (started_at DESC);
