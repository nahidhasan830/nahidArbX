CREATE TABLE IF NOT EXISTS "event_matcher_scheduler_settings" (
  "id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "interval_seconds" integer DEFAULT 60 NOT NULL,
  "use_deepseek" boolean DEFAULT true NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

INSERT INTO "event_matcher_scheduler_settings" (
  "id",
  "enabled",
  "interval_seconds",
  "use_deepseek"
)
VALUES (1, true, 60, true)
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "matcher_decisions"
  ALTER COLUMN "dry_run" SET DEFAULT false;

DROP TABLE IF EXISTS "event_matcher_runs";

ALTER TABLE "matcher_candidates"
  ADD COLUMN IF NOT EXISTS "shape_fingerprint" text,
  ADD COLUMN IF NOT EXISTS "scoring_version" text,
  ADD COLUMN IF NOT EXISTS "grounding_version" text;

UPDATE "matcher_candidates"
SET
  "shape_fingerprint" = COALESCE("shape_fingerprint", "candidate_key"),
  "scoring_version" = COALESCE("scoring_version", 'event-matcher-scoring-v1'),
  "grounding_version" = COALESCE("grounding_version", 'event-matcher-grounding-v1');

ALTER TABLE "matcher_candidates"
  ALTER COLUMN "shape_fingerprint" SET NOT NULL,
  ALTER COLUMN "scoring_version" SET NOT NULL,
  ALTER COLUMN "grounding_version" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "matcher_candidates_shape_idx"
  ON "matcher_candidates" ("shape_fingerprint");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'canonical_event_members_canonical_fk'
  ) THEN
    ALTER TABLE "canonical_event_members"
      ADD CONSTRAINT "canonical_event_members_canonical_fk"
      FOREIGN KEY ("canonical_event_id") REFERENCES "canonical_events" ("id")
      ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'canonical_event_members_snapshot_fk'
  ) THEN
    ALTER TABLE "canonical_event_members"
      ADD CONSTRAINT "canonical_event_members_snapshot_fk"
      FOREIGN KEY ("snapshot_id") REFERENCES "provider_event_snapshots" ("id")
      ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'matcher_candidates_snapshot_a_fk'
  ) THEN
    ALTER TABLE "matcher_candidates"
      ADD CONSTRAINT "matcher_candidates_snapshot_a_fk"
      FOREIGN KEY ("snapshot_a_id") REFERENCES "provider_event_snapshots" ("id")
      ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'matcher_candidates_snapshot_b_fk'
  ) THEN
    ALTER TABLE "matcher_candidates"
      ADD CONSTRAINT "matcher_candidates_snapshot_b_fk"
      FOREIGN KEY ("snapshot_b_id") REFERENCES "provider_event_snapshots" ("id")
      ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'matcher_decisions_candidate_fk'
  ) THEN
    ALTER TABLE "matcher_decisions"
      ADD CONSTRAINT "matcher_decisions_candidate_fk"
      FOREIGN KEY ("candidate_id") REFERENCES "matcher_candidates" ("id")
      ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'matcher_decisions_canonical_fk'
  ) THEN
    ALTER TABLE "matcher_decisions"
      ADD CONSTRAINT "matcher_decisions_canonical_fk"
      FOREIGN KEY ("canonical_event_id") REFERENCES "canonical_events" ("id")
      ON DELETE SET NULL;
  END IF;
END $$;
