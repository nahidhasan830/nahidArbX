-- Settlement-waterfall Tier 0: permanent score cache keyed on normalized eventId.
-- Populated opportunistically by the cheapest source that resolves a final
-- score (live feeds → free score APIs). Scores are
-- immutable once status='FT', so this table is effectively write-once per
-- event — re-settlement hits it first for $0.
CREATE TABLE IF NOT EXISTS "match_scores" (
  "event_id"    text PRIMARY KEY NOT NULL,
  "status"      text NOT NULL,
  "ht_home"     integer,
  "ht_away"     integer,
  "ft_home"     integer NOT NULL,
  "ft_away"     integer NOT NULL,
  "et_home"     integer,
  "et_away"     integer,
  "pen_home"    integer,
  "pen_away"    integer,
  "source"      text NOT NULL,
  "confidence"  numeric(3, 2) NOT NULL,
  "source_url"  text,
  "fetched_at"  timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "match_scores_status_idx" ON "match_scores" ("status");
