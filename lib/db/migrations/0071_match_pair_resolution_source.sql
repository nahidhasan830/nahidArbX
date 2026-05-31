-- Legacy Matcher Lab resolution-source migration.
-- No-op after 0076 drops match_pairs.
DO $$
BEGIN
  IF to_regclass('public.match_pairs') IS NOT NULL THEN
    ALTER TABLE "match_pairs"
      ADD COLUMN IF NOT EXISTS "resolution_source" text;

    UPDATE "match_pairs"
       SET "resolution_source" = coalesce("resolution_source", "decided_by")
     WHERE "stage" = 'history';

    CREATE INDEX IF NOT EXISTS "match_pairs_resolution_source_idx"
      ON "match_pairs" ("resolution_source");
  END IF;
END $$;
