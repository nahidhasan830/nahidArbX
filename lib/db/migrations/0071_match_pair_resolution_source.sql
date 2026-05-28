-- Track which resolver actually settled a Matcher Lab event pair.
ALTER TABLE "match_pairs"
  ADD COLUMN IF NOT EXISTS "resolution_source" text;

UPDATE "match_pairs"
SET "resolution_source" = "decided_by"
WHERE "resolution_source" IS NULL
  AND "decided_by" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "match_pairs_resolution_source_idx"
  ON "match_pairs" ("resolution_source");
