-- ============================================================================
-- Entity Resolution v2 — operator review queue
-- ============================================================================
--
-- Holds findings from the weekly entity-resolver Cloud Run Job that need
-- operator approval before being applied. Three kinds of findings:
--
--   - merge:    two entities should be one. Splink/Leiden pass surfaces
--               candidates with prob > 0.85 (auto-applies if > 0.99).
--   - split:    one entity contains surfaces that should belong to
--               separate entities (cluster cohesion below threshold).
--   - conflict: candidate row has competing claim from another candidate
--               with comparable evidence — promoter punted to operator.
--
-- Operator UI (`EntityInspector.tsx`) lists unresolved rows ordered by
-- expected information gain. Resolution flips `resolved=true` and
-- records `resolution` ("approved-merged", "rejected", "split-applied",
-- etc.) for audit.

CREATE TABLE IF NOT EXISTS entity_review_queue (
  id                   TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL CHECK (kind IN ('merge','split','conflict')),
  source               TEXT NOT NULL,                  -- 'splink' | 'leiden' | 'promoter'
  entity_id_a          TEXT REFERENCES entities(id),
  entity_id_b          TEXT REFERENCES entities(id),
  entity_name_id_a     TEXT,
  entity_name_id_b     TEXT,
  probability          REAL NOT NULL,
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved             BOOLEAN NOT NULL DEFAULT false,
  resolved_at          TIMESTAMPTZ,
  resolution           TEXT,                            -- 'approved-merged' | 'rejected' | 'split-applied' | etc
  resolved_by          TEXT
);

CREATE INDEX IF NOT EXISTS entity_review_queue_unresolved_idx
  ON entity_review_queue(kind, created_at DESC)
  WHERE resolved = false;

CREATE INDEX IF NOT EXISTS entity_review_queue_recent_idx
  ON entity_review_queue(created_at DESC);
