CREATE TABLE IF NOT EXISTS "provider_event_snapshots" (
  "id" text PRIMARY KEY NOT NULL,
  "provider" text NOT NULL,
  "provider_event_id" text NOT NULL,
  "sport" text DEFAULT 'football' NOT NULL,
  "home_team_raw" text NOT NULL,
  "away_team_raw" text NOT NULL,
  "competition_raw" text NOT NULL,
  "home_team_normalized" text NOT NULL,
  "away_team_normalized" text NOT NULL,
  "competition_normalized" text NOT NULL,
  "raw_start_time" text,
  "parsed_kickoff" timestamp with time zone NOT NULL,
  "parse_strategy" text NOT NULL,
  "fetch_batch_id" text NOT NULL,
  "provider_metadata" jsonb,
  "raw_payload" jsonb,
  "captured_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone,
  CONSTRAINT "provider_event_snapshots_provider_event_uidx"
    UNIQUE ("provider", "provider_event_id")
);

CREATE INDEX IF NOT EXISTS "provider_event_snapshots_provider_idx"
  ON "provider_event_snapshots" ("provider");
CREATE INDEX IF NOT EXISTS "provider_event_snapshots_kickoff_idx"
  ON "provider_event_snapshots" ("parsed_kickoff");
CREATE INDEX IF NOT EXISTS "provider_event_snapshots_batch_idx"
  ON "provider_event_snapshots" ("fetch_batch_id");

CREATE TABLE IF NOT EXISTS "canonical_events" (
  "id" text PRIMARY KEY NOT NULL,
  "sport" text DEFAULT 'football' NOT NULL,
  "home_team_canonical" text NOT NULL,
  "away_team_canonical" text NOT NULL,
  "competition_canonical" text NOT NULL,
  "kickoff" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_by_run_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "canonical_events_kickoff_idx"
  ON "canonical_events" ("kickoff");
CREATE INDEX IF NOT EXISTS "canonical_events_status_idx"
  ON "canonical_events" ("status");

CREATE TABLE IF NOT EXISTS "canonical_event_members" (
  "id" text PRIMARY KEY NOT NULL,
  "canonical_event_id" text NOT NULL,
  "snapshot_id" text NOT NULL,
  "provider" text NOT NULL,
  "provider_event_id" text NOT NULL,
  "decision_id" text,
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "canonical_event_members_snapshot_uidx" UNIQUE ("snapshot_id"),
  CONSTRAINT "canonical_event_members_provider_event_uidx"
    UNIQUE ("provider", "provider_event_id")
);

CREATE INDEX IF NOT EXISTS "canonical_event_members_canonical_idx"
  ON "canonical_event_members" ("canonical_event_id");

CREATE TABLE IF NOT EXISTS "matcher_candidates" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "snapshot_a_id" text NOT NULL,
  "snapshot_b_id" text NOT NULL,
  "provider_a" text NOT NULL,
  "provider_b" text NOT NULL,
  "candidate_key" text NOT NULL,
  "shape_fingerprint" text NOT NULL,
  "scoring_version" text NOT NULL,
  "grounding_version" text NOT NULL,
  "status" text DEFAULT 'generated' NOT NULL,
  "hard_blockers" jsonb NOT NULL,
  "reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "score_breakdown" jsonb,
  "combined_score" real,
  "source_stage" text DEFAULT 'candidate_generation' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "matcher_candidates_candidate_key_unique" UNIQUE ("candidate_key")
);

CREATE INDEX IF NOT EXISTS "matcher_candidates_run_idx"
  ON "matcher_candidates" ("run_id");
CREATE INDEX IF NOT EXISTS "matcher_candidates_status_idx"
  ON "matcher_candidates" ("status");
CREATE INDEX IF NOT EXISTS "matcher_candidates_provider_pair_idx"
  ON "matcher_candidates" ("provider_a", "provider_b");
CREATE INDEX IF NOT EXISTS "matcher_candidates_shape_idx"
  ON "matcher_candidates" ("shape_fingerprint");

CREATE TABLE IF NOT EXISTS "matcher_decisions" (
  "id" text PRIMARY KEY NOT NULL,
  "run_id" text NOT NULL,
  "candidate_id" text NOT NULL,
  "decision" text NOT NULL,
  "decision_stage" text NOT NULL,
  "confidence" real NOT NULL,
  "confidence_band" text NOT NULL,
  "final" boolean DEFAULT false NOT NULL,
  "dry_run" boolean DEFAULT false NOT NULL,
  "reason_code" text NOT NULL,
  "reason_summary" text NOT NULL,
  "hard_blockers" jsonb NOT NULL,
  "score_breakdown" jsonb NOT NULL,
  "evidence" jsonb,
  "model" text,
  "canonical_event_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "matcher_decisions_run_idx"
  ON "matcher_decisions" ("run_id");
CREATE INDEX IF NOT EXISTS "matcher_decisions_candidate_idx"
  ON "matcher_decisions" ("candidate_id");
CREATE INDEX IF NOT EXISTS "matcher_decisions_stage_idx"
  ON "matcher_decisions" ("decision_stage");
CREATE INDEX IF NOT EXISTS "matcher_decisions_created_idx"
  ON "matcher_decisions" ("created_at" DESC);

CREATE TABLE IF NOT EXISTS "matcher_impact_daily" (
  "id" text PRIMARY KEY NOT NULL,
  "day" text NOT NULL,
  "provider_pair" text NOT NULL,
  "source_stage" text NOT NULL,
  "confidence_band" text NOT NULL,
  "active_matched_events" integer DEFAULT 0 NOT NULL,
  "exact_deterministic_matches" integer DEFAULT 0 NOT NULL,
  "matcher_helped_matches" integer DEFAULT 0 NOT NULL,
  "deepseek_resolved" integer DEFAULT 0 NOT NULL,
  "review_avoided" integer DEFAULT 0 NOT NULL,
  "dry_run_matches" integer DEFAULT 0 NOT NULL,
  "examples" jsonb,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "matcher_impact_daily_rollup_uidx"
    UNIQUE ("day", "provider_pair", "source_stage", "confidence_band")
);

CREATE INDEX IF NOT EXISTS "matcher_impact_daily_day_idx"
  ON "matcher_impact_daily" ("day");

ALTER TABLE "canonical_event_members"
  ADD CONSTRAINT "canonical_event_members_canonical_fk"
    FOREIGN KEY ("canonical_event_id")
    REFERENCES "canonical_events" ("id")
    ON DELETE CASCADE,
  ADD CONSTRAINT "canonical_event_members_snapshot_fk"
    FOREIGN KEY ("snapshot_id")
    REFERENCES "provider_event_snapshots" ("id")
    ON DELETE CASCADE;

ALTER TABLE "matcher_candidates"
  ADD CONSTRAINT "matcher_candidates_snapshot_a_fk"
    FOREIGN KEY ("snapshot_a_id")
    REFERENCES "provider_event_snapshots" ("id")
    ON DELETE CASCADE,
  ADD CONSTRAINT "matcher_candidates_snapshot_b_fk"
    FOREIGN KEY ("snapshot_b_id")
    REFERENCES "provider_event_snapshots" ("id")
    ON DELETE CASCADE;

ALTER TABLE "matcher_decisions"
  ADD CONSTRAINT "matcher_decisions_candidate_fk"
    FOREIGN KEY ("candidate_id")
    REFERENCES "matcher_candidates" ("id")
    ON DELETE CASCADE,
  ADD CONSTRAINT "matcher_decisions_canonical_fk"
    FOREIGN KEY ("canonical_event_id")
    REFERENCES "canonical_events" ("id")
    ON DELETE SET NULL;
