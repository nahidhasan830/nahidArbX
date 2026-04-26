-- ============================================================================
-- ML-Augmented Matcher Pipeline — match_pairs table
-- ============================================================================
--
-- Stores event pairs that flow through the 4-stage matcher pipeline:
--   INBOX → ML_QUEUED → ML_RESOLVED/HUMAN_REVIEW → HISTORY
--
-- Near-matches (string score 0.70–0.849) and unmatched cross-provider
-- candidates land in INBOX from the sync cycle. A background scheduler
-- batches them through the bi-encoder (BGE-M3) and cross-encoder
-- (BGE-reranker-v2-m3) on Cloud Run, auto-merging high-confidence pairs
-- and surfacing uncertain ones for human review.
--
-- Replaces the file-backed rawData/near-matches.json and
-- data/gemini/ai-decision-cache.json stores.

CREATE TABLE IF NOT EXISTS match_pairs (
  id                   TEXT PRIMARY KEY,
  stage                TEXT NOT NULL CHECK (stage IN ('inbox','ml_queued','ml_resolved','human_review','history')),

  -- Event A snapshot
  event_a_provider     TEXT NOT NULL,
  event_a_home_team    TEXT NOT NULL,
  event_a_away_team    TEXT NOT NULL,
  event_a_competition  TEXT NOT NULL,
  event_a_start_time   TIMESTAMPTZ NOT NULL,
  event_a_event_id     TEXT,

  -- Event B snapshot
  event_b_provider     TEXT NOT NULL,
  event_b_home_team    TEXT NOT NULL,
  event_b_away_team    TEXT NOT NULL,
  event_b_competition  TEXT NOT NULL,
  event_b_start_time   TIMESTAMPTZ NOT NULL,
  event_b_event_id     TEXT,

  -- String similarity (from sync)
  string_score         REAL NOT NULL,
  string_breakdown     JSONB,

  -- ML scores (filled by scheduler — bi-encoder)
  ml_home_cosine       REAL,
  ml_away_cosine       REAL,
  ml_comp_cosine       REAL,
  ml_combined_score    REAL,
  ml_scored_at         TIMESTAMPTZ,
  ml_model_version     TEXT,

  -- Cross-encoder (if bi-encoder is uncertain)
  xe_score             REAL,
  xe_pvalue            REAL,
  xe_scored_at         TIMESTAMPTZ,

  -- Resolution
  decision             TEXT CHECK (decision IN (
    'auto-merge','auto-reject',
    'human-merge','human-reject',
    'ai-merge','ai-reject'
  )),
  decided_by           TEXT,
  decided_at           TIMESTAMPTZ,
  decision_reason      TEXT,

  -- Canonical pair key (dedup + lookup)
  pair_key             TEXT NOT NULL UNIQUE,

  -- Timestamps
  detected_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  stage_changed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Source tracking
  source               TEXT NOT NULL CHECK (source IN ('near-match','unmatched-candidate'))
);

CREATE INDEX IF NOT EXISTS match_pairs_stage_idx
  ON match_pairs(stage);

CREATE INDEX IF NOT EXISTS match_pairs_stage_detected_idx
  ON match_pairs(stage, detected_at DESC);

CREATE INDEX IF NOT EXISTS match_pairs_pair_key_idx
  ON match_pairs(pair_key);
