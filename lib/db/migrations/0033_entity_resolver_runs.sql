-- ============================================================================
-- Entity Resolution v2 — Cloud Run Job execution tracking
-- ============================================================================
--
-- One row per execution of the weekly entity-resolver Job (Splink + Leiden
-- + embedding backfill + classifier retrain). The Job writes progress
-- rows as it advances through each pass; the UI polls for live status
-- without needing direct Cloud Run / Logs access.
--
-- Lifecycle: queued → running → succeeded | failed | cancelled.
--
-- The progress JSONB tracks per-pass state:
--   {
--     "pass": "embedding-backfill" | "splink" | "leiden" | "retrain",
--     "started_at": "...",
--     "embeddings_written": 1234,
--     "splink_pairs_scored": 5678,
--     "merges": 3, "splits": 1, "conflicts": 0,
--     "leiden_communities": 12,
--     "classifier_auc": 0.973
--   }

CREATE TABLE IF NOT EXISTS entity_resolver_runs (
  id              TEXT PRIMARY KEY,
  status          TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  trigger_source  TEXT NOT NULL,                              -- 'cron' | 'manual' | 'api'
  triggered_by    TEXT,
  cloud_run_execution TEXT,                                   -- the Cloud Run Jobs execution name
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  duration_ms     INTEGER,
  current_pass    TEXT,                                       -- mirror of progress.pass for fast filtering
  progress        JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary         JSONB NOT NULL DEFAULT '{}'::jsonb,         -- final aggregated counts (after run)
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entity_resolver_runs_recent_idx
  ON entity_resolver_runs(created_at DESC);

CREATE INDEX IF NOT EXISTS entity_resolver_runs_status_idx
  ON entity_resolver_runs(status, created_at DESC);

CREATE INDEX IF NOT EXISTS entity_resolver_runs_active_idx
  ON entity_resolver_runs(status)
  WHERE status IN ('queued','running');
