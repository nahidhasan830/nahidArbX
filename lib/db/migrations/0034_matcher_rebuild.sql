-- ============================================================================
-- Matcher Lab rebuild — drop legacy ML scaffolding, add rebuild scaffolding
-- ============================================================================
--
-- The 4-tier promoter (deterministic + Bayesian + LightGBM + operator queue)
-- and the weekly Splink/Leiden cleanup Job are being replaced by a single
-- multi-stage auto-resolver: deterministic gates → co-occurrence →
-- bi-encoder cosine → cross-encoder + conformal calibration → operator inbox.
--
-- This migration:
--   1. Drops `entity_review_queue` (no more Splink/Leiden findings to queue —
--      the cross-encoder + operator inbox cover the same workflow at our scale).
--   2. Drops `entity_resolver_runs` (no more weekly cleanup Job; replaced by
--      a much smaller weekly trainer Job tracked in `entity_trainer_runs`).
--   3. Migrates `entity_names.surface_embedding` from vector(384) (LaBSE) to
--      vector(1024) (BGE-M3) — drops the old data because the dimensions
--      don't align; the new entity-matcher service repopulates them on demand.
--   4. Creates `entity_trainer_runs` to track weekly fine-tuning of the
--      cross-encoder, with shadow-mode tracking columns for Layer 3 of the
--      error-mitigation strategy.
--   5. Creates `entity_decision_blocklist` for Layer 1 (reversibility):
--      operator overrides write a 30-day blocklist entry so the auto-resolver
--      never re-applies the same wrong decision.

-- ── 1. Drop the operator review queue (Splink/Leiden) ─────────────────────
-- Idempotent — the `IF EXISTS` lets us replay this migration safely.
DROP TABLE IF EXISTS entity_review_queue;

-- ── 2. Drop the weekly resolver-Job execution log ─────────────────────────
DROP TABLE IF EXISTS entity_resolver_runs;

-- ── 3. Migrate surface_embedding column from vector(384) to vector(1024) ──
-- BGE-M3 outputs 1024-dim embeddings; the old LaBSE-384 data isn't useful
-- (different model, different vector space). Drop and re-add — the matcher
-- service will refill from /embed calls as surfaces get observed.
DROP INDEX IF EXISTS entity_names_embedding_idx;
ALTER TABLE entity_names DROP COLUMN IF EXISTS surface_embedding;
ALTER TABLE entity_names ADD COLUMN surface_embedding vector(1024);

-- ivfflat index — lists=100 is reasonable for ~5-10k surfaces. Rebuild
-- with more lists if we cross 100k.
CREATE INDEX entity_names_embedding_idx
  ON entity_names USING ivfflat (surface_embedding vector_cosine_ops)
  WITH (lists = 100);

-- ── 4. Trainer-run tracking (replaces resolver-run tracking) ──────────────
-- One row per execution of the weekly entity-trainer Cloud Run Job. The Job
-- fine-tunes bge-reranker-v2-m3 on accumulated operator-confirmed pairs and
-- recalibrates the MAPIE conformal predictor.
--
-- Shadow-mode columns (Layer 3): a freshly-trained model is "in_shadow"
-- until it accumulates 100 auto-confirm decisions with ≥99% operator
-- agreement. Until then, auto-resolver routes all decisions to operator
-- inbox marked "model wants to confirm — agree?". Once the model proves
-- itself, `promoted_to_trusted_at` flips to non-NULL and full auto resumes.
CREATE TABLE IF NOT EXISTS entity_trainer_runs (
  id                       TEXT PRIMARY KEY,
  status                   TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  triggered_by             TEXT NOT NULL,                 -- 'cron' | 'manual' | user id
  cloud_run_execution      TEXT,
  started_at               TIMESTAMPTZ,
  finished_at              TIMESTAMPTZ,
  duration_ms              INTEGER,
  pairs_trained            INTEGER,                       -- positives + negatives in this run
  accuracy_before          REAL,                          -- pre-fine-tune AUC on holdout
  accuracy_after           REAL,                          -- post-fine-tune AUC on holdout
  promoted_to_trusted_at   TIMESTAMPTZ,                   -- shadow-mode → trusted
  shadow_decisions_seen    INTEGER NOT NULL DEFAULT 0,
  shadow_agreements        INTEGER NOT NULL DEFAULT 0,
  artefact_uri             TEXT,                          -- gs://… path to the calibrator + weights
  error                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entity_trainer_runs_recent_idx
  ON entity_trainer_runs(created_at DESC);

CREATE INDEX IF NOT EXISTS entity_trainer_runs_active_idx
  ON entity_trainer_runs(status)
  WHERE status IN ('queued','running');

-- ── 5. Override blocklist (Layer 1: reversibility) ────────────────────────
-- When the operator overrides an auto-decision, we add a 30-day blocklist
-- entry on the (provider, surface, competition, blocked_entity) tuple. The
-- auto-resolver checks this blocklist BEFORE applying any auto-confirm —
-- so the system never re-applies the same wrong decision. After 30 days
-- the entry expires and the system can try again (the model has had time
-- to retrain on the negative signal by then).
CREATE TABLE IF NOT EXISTS entity_decision_blocklist (
  id                  BIGSERIAL PRIMARY KEY,
  provider            TEXT NOT NULL,
  surface_normalized  TEXT NOT NULL,
  competition_id      TEXT REFERENCES entities(id),
  blocked_entity_id   TEXT NOT NULL REFERENCES entities(id),
  reason              TEXT NOT NULL CHECK (reason IN
    ('manual-reject','manual-confirm-undone','tainted-cascade')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days')
);

-- Hot-path lookup index: auto-resolver checks this on every potential
-- auto-confirm. Can't use a partial index on `expires_at > now()` because
-- now() isn't IMMUTABLE — Postgres rejects it as an index predicate. Full
-- index is fine here: this table only ever grows by ~one row per operator
-- override, expired-cleanup keeps it bounded to hundreds of rows.
CREATE INDEX IF NOT EXISTS entity_blocklist_lookup_idx
  ON entity_decision_blocklist
  (provider, surface_normalized, competition_id, blocked_entity_id);

-- Sweeper index — a tiny daily Job will DELETE expired rows.
CREATE INDEX IF NOT EXISTS entity_blocklist_expiry_idx
  ON entity_decision_blocklist(expires_at);
