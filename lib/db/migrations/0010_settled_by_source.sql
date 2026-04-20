-- Record which part of the settlement pipeline produced each bet's
-- outcome. Values mirror `match_scores.source` — e.g. 'espn',
-- 'sofascore', 'pinnacle-ws', 'url-context', 'manual', etc. NULL on
-- bets settled before this column existed.
ALTER TABLE "value_bets"
  ADD COLUMN IF NOT EXISTS "settled_by_source" text;

CREATE INDEX IF NOT EXISTS "value_bets_settled_by_idx"
  ON "value_bets" ("settled_by_source")
  WHERE "settled_by_source" IS NOT NULL;
