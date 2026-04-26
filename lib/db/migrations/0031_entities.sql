-- ============================================================================
-- Entity Resolution v2 — replaces JSON alias store
-- ============================================================================
--
-- The old JSON-backed `data/aliases/{team,competition}-aliases.json` system
-- learned global, tournament-blind, name-to-name aliases that were impossible
-- to roll back and prone to silently-wrong canonical mappings (e.g. obolon →
-- obolon kyiv metalurh donetsk after 26 false-confirm cycles).
--
-- The new model is three tables:
--
--   1. entities             — stable real-world things (teams, competitions)
--   2. entity_names         — every (provider, surface, competition) we've
--                             ever seen, bound to an entity. THE lookup table.
--   3. name_observations    — append-only audit of every match attempt
--
-- Lookup key is (provider, surface_normalized, competition_id) → entity, so
-- "Athletic" in La Liga and "Athletic" in Colombian Primera A can coexist.
--
-- pgvector is enabled for multilingual embedding-based fallback lookup
-- (catches transliteration cases like "công an hồ chí minh city" vs
-- "ho chi minh city"). The Cloud Run entity-classifier Job populates
-- the embeddings column in batch.

CREATE EXTENSION IF NOT EXISTS vector;

-- ── entities ──────────────────────────────────────────────────────────────
--
-- One row per real-world team or competition. Soft-delete via retired_at —
-- never hard-delete because observations and bets reference these IDs.
CREATE TABLE IF NOT EXISTS entities (
  id              TEXT PRIMARY KEY,                -- deterministic: kind|country|gender|slug
  kind            TEXT NOT NULL CHECK (kind IN ('team','competition')),
  canonical_name  TEXT NOT NULL,
  country         TEXT,
  gender          TEXT CHECK (gender IS NULL OR gender IN ('m','f')),
  parent_id       TEXT REFERENCES entities(id),    -- team -> primary competition (nullable)
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS entities_kind_idx ON entities(kind) WHERE retired_at IS NULL;
CREATE INDEX IF NOT EXISTS entities_canonical_idx ON entities(lower(canonical_name)) WHERE retired_at IS NULL;
CREATE INDEX IF NOT EXISTS entities_parent_idx ON entities(parent_id) WHERE parent_id IS NOT NULL;


-- ── entity_names ──────────────────────────────────────────────────────────
--
-- Every (provider, surface_form, competition_context) we've ever seen,
-- bound to an entity. THIS is the lookup table consulted on the matching
-- hot path. The composite UNIQUE constraint is the killer fix for the
-- old "first writer wins" silent-conflict problem.
CREATE TABLE IF NOT EXISTS entity_names (
  id                   TEXT PRIMARY KEY,
  entity_id            TEXT NOT NULL REFERENCES entities(id),
  competition_id       TEXT REFERENCES entities(id),  -- NULL = global (rare)
  provider             TEXT NOT NULL,
  surface_raw          TEXT NOT NULL,
  surface_normalized   TEXT NOT NULL,
  surface_embedding    vector(384),                   -- LaBSE / sentence-transformers; populated by classifier Job
  weight               REAL NOT NULL DEFAULT 1.0,
  positive_obs         INTEGER NOT NULL DEFAULT 0,
  negative_obs         INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL CHECK (status IN ('candidate','active','retired')),
  classifier_score     REAL,                          -- last Tier-2 ML probability
  conformal_pvalue     REAL,                          -- conformal calibration p-value
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_at          TIMESTAMPTZ,
  retired_at           TIMESTAMPTZ,
  CONSTRAINT entity_names_unique_surface UNIQUE (provider, surface_normalized, competition_id)
);

CREATE INDEX IF NOT EXISTS entity_names_active_lookup_idx
  ON entity_names(provider, surface_normalized, competition_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS entity_names_global_lookup_idx
  ON entity_names(surface_normalized)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS entity_names_entity_idx ON entity_names(entity_id);

CREATE INDEX IF NOT EXISTS entity_names_candidate_idx
  ON entity_names(last_seen_at DESC)
  WHERE status = 'candidate';

CREATE INDEX IF NOT EXISTS entity_names_decay_idx
  ON entity_names(last_seen_at)
  WHERE status = 'active';

-- ivfflat index for embedding-similarity search; only useful once the
-- classifier Job populates embeddings. lists=50 is a reasonable starting
-- point for ~5k surfaces; rebuild with more lists when we cross 50k.
CREATE INDEX IF NOT EXISTS entity_names_embedding_idx
  ON entity_names USING ivfflat (surface_embedding vector_cosine_ops)
  WITH (lists = 50);


-- ── name_observations ────────────────────────────────────────────────────
--
-- Append-only audit log. Every recordObservation() call writes a row here.
-- The promoter reads this to decide what to promote/demote/retire. The
-- review queue surfaces uncertain observations to the operator. Keeps the
-- "why was this alias learned?" forensic question answerable forever.
CREATE TABLE IF NOT EXISTS name_observations (
  id                       BIGSERIAL PRIMARY KEY,
  observed_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  surface_raw              TEXT NOT NULL,
  surface_normalized       TEXT NOT NULL,
  competition_id           TEXT REFERENCES entities(id),
  provider                 TEXT NOT NULL,
  paired_with_entity_id    TEXT REFERENCES entities(id),
  match_score              REAL,
  classifier_score         REAL,
  outcome                  TEXT NOT NULL CHECK (outcome IN
    ('matched','rejected','near-match','manual-confirm','manual-reject')),
  source                   TEXT NOT NULL,                 -- 'harvester' | 'match-review' | 'learner' | 'settle'
  metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS name_obs_lookup_idx
  ON name_observations(surface_normalized, competition_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS name_obs_recent_idx
  ON name_observations(observed_at DESC);

CREATE INDEX IF NOT EXISTS name_obs_entity_idx
  ON name_observations(paired_with_entity_id, observed_at DESC)
  WHERE paired_with_entity_id IS NOT NULL;
