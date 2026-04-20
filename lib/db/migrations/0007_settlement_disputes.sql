-- Score disagreements between tiers — caught when a secondary source
-- resolves a match we already have cached and returns a different score.
-- Humans review these rows to decide which source to trust.
CREATE TABLE IF NOT EXISTS "settlement_disputes" (
  "id"                text PRIMARY KEY NOT NULL,
  "event_id"          text NOT NULL,
  "cached_source"     text NOT NULL,
  "cached_ft_home"    integer NOT NULL,
  "cached_ft_away"    integer NOT NULL,
  "new_source"        text NOT NULL,
  "new_ft_home"       integer NOT NULL,
  "new_ft_away"       integer NOT NULL,
  "cached_confidence" numeric(3, 2) NOT NULL,
  "new_confidence"    numeric(3, 2) NOT NULL,
  "resolved"          boolean NOT NULL DEFAULT false,
  "resolution"        text,
  "detected_at"       timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at"       timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "settlement_disputes_event_idx"
  ON "settlement_disputes" ("event_id");
CREATE INDEX IF NOT EXISTS "settlement_disputes_unresolved_idx"
  ON "settlement_disputes" ("detected_at" DESC)
  WHERE "resolved" = false;
