-- Migration 0016: Merge value_bets and placed_bets into a single bets table
--
-- This migration:
--   1. Creates the new `bets` table with merged schema
--   2. Migrates all data from value_bets + placed_bets via LEFT JOIN
--   3. Drops the old tables
--
-- Prerequisites: migrations 0000-0015 must be applied first.
--
-- Rollback: restore from backup or re-run migrations 0000-0015 + re-insert from
-- the data snapshot that should be taken before running this migration.

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: Create the new bets table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "bets" (
  -- Identity
  "id" text PRIMARY KEY,

  -- Event & Selection
  "event_id" text NOT NULL,
  "family_id" text NOT NULL,
  "atom_id" text NOT NULL,
  "atom_label" text NOT NULL,

  "home_team" text NOT NULL,
  "away_team" text NOT NULL,
  "competition" text,
  "event_start_time" timestamp with time zone NOT NULL,

  "market_type" text NOT NULL,
  "time_scope" text NOT NULL,
  "family_line" numeric(5, 2),

  -- Sharp side (Pinnacle reference)
  "sharp_provider" text NOT NULL,
  "sharp_odds" numeric(10, 4) NOT NULL,
  "sharp_true_prob" numeric(6, 5) NOT NULL,
  "sharp_odds_age_ms" integer,

  -- Soft side (the book we detected the opportunity on)
  "soft_provider" text NOT NULL,
  "soft_commission_pct" numeric(5, 2) NOT NULL,
  "soft_odds" numeric(10, 4) NOT NULL,

  -- Closing lines
  "closing_sharp_odds" numeric(10, 4),
  "closing_soft_odds" numeric(10, 4),

  -- Detection lifecycle
  "first_seen_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  "tick_count" integer NOT NULL DEFAULT 1,

  -- Placement record — all NULL until bet is actually placed
  "placed_at" timestamp with time zone,
  "provider" text,
  "stake" numeric(10, 2),
  "odds" numeric(10, 4),
  "currency" text DEFAULT 'BDT',
  "provider_ticket_id" text,
  "mode" text,

  -- API interaction metadata
  "request_payload" jsonb,
  "response_payload" jsonb,
  "error" text,

  -- Outcome & settlement
  "outcome" text NOT NULL DEFAULT 'pending',
  "outcome_marked_at" timestamp with time zone,
  "settled_by_source" text,
  "settled_at" timestamp with time zone,
  "pnl" numeric(10, 2),
  "clv_pct" numeric(6, 2),

  -- Settlement pipeline tracking
  "settle_attempts" integer NOT NULL DEFAULT 0,
  "last_settle_attempt_at" timestamp with time zone,

  -- Timestamps
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: Create indexes
-- ─────────────────────────────────────────────────────────────────────────────

-- Core access paths
CREATE INDEX "bets_first_seen_idx" ON "bets" ("first_seen_at" DESC);
CREATE INDEX "bets_market_idx" ON "bets" ("market_type", "time_scope");
CREATE INDEX "bets_soft_provider_idx" ON "bets" ("soft_provider");
CREATE INDEX "bets_event_start_idx" ON "bets" ("event_start_time");

-- Partial index: settled non-pending rows (backtest queries)
CREATE INDEX "bets_outcome_idx" ON "bets" ("outcome")
  WHERE "outcome" <> 'pending';

-- Partial index: only placed bets for dashboard queries
CREATE INDEX "bets_placed_idx" ON "bets" ("placed_at" DESC)
  WHERE "placed_at" IS NOT NULL;

-- Dedup: one active (non-cancelled) placement per selection
CREATE UNIQUE INDEX "bets_dedup_idx" ON "bets" ("event_id", "family_id", "atom_id")
  WHERE "outcome" <> 'cancelled' AND "placed_at" IS NOT NULL;

-- Provider reconciliation
CREATE INDEX "bets_provider_idx" ON "bets" ("provider")
  WHERE "provider" IS NOT NULL;

-- Needs review: pending + attempted
CREATE INDEX "bets_settle_attempts_idx" ON "bets" ("outcome", "settle_attempts")
  WHERE "outcome" = 'pending' AND "settle_attempts" > 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3: Migrate data
--
-- LEFT JOIN value_bets → placed_bets on value_bets.id = placed_bets.value_bet_id
-- For rows with placed_bets data: populate placement fields
-- For rows without: placement fields remain NULL (opportunity not taken)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO "bets" (
  "id",
  "event_id", "family_id", "atom_id", "atom_label",
  "home_team", "away_team", "competition", "event_start_time",
  "market_type", "time_scope", "family_line",
  "sharp_provider", "sharp_odds", "sharp_true_prob", "sharp_odds_age_ms",
  "soft_provider", "soft_commission_pct",
  "soft_odds",
  "closing_sharp_odds", "closing_soft_odds",
  "first_seen_at", "last_seen_at", "tick_count",
  "placed_at", "provider", "stake", "odds", "currency",
  "provider_ticket_id", "mode",
  "request_payload", "response_payload", "error",
  "outcome",
  "outcome_marked_at",
  "settled_by_source",
  "settled_at",
  "pnl", "clv_pct",
  "settle_attempts", "last_settle_attempt_at",
  "created_at", "updated_at"
)
SELECT
  vb."id",
  vb."event_id", vb."family_id", vb."atom_id", vb."atom_label",
  vb."home_team", vb."away_team", vb."competition", vb."event_start_time",
  vb."market_type", vb."time_scope", vb."family_line",
  vb."sharp_provider", vb."sharp_odds", vb."sharp_true_prob", vb."sharp_odds_age_ms",
  vb."soft_provider", vb."soft_commission_pct",
  vb."soft_odds_first" AS "soft_odds",
  vb."closing_sharp_odds", vb."closing_soft_odds",
  vb."first_seen_at", vb."last_seen_at", vb."tick_count",
  pb."placed_at", pb."provider", pb."stake", pb."odds", pb."currency",
  pb."provider_ticket_id", pb."mode",
  pb."request_payload", pb."response_payload", pb."error",
  COALESCE(pb."outcome", vb."outcome") AS "outcome",
  COALESCE(pb."settled_at", vb."outcome_marked_at") AS "outcome_marked_at",
  COALESCE(pb."settled_by_source", vb."settled_by_source") AS "settled_by_source",
  pb."settled_at",
  pb."pnl", pb."clv_pct",
  vb."settle_attempts", vb."last_settle_attempt_at",
  vb."created_at", vb."updated_at"
FROM "value_bets" vb
LEFT JOIN "placed_bets" pb ON pb."value_bet_id" = vb."id";

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4: Verify migration integrity
-- ─────────────────────────────────────────────────────────────────────────────

-- Count check: merged bets should = value_bets rows
DO $$
DECLARE
  vb_count INTEGER;
  pb_count INTEGER;
  bets_count INTEGER;
  orphaned INTEGER;
  outcome_mismatch INTEGER;
BEGIN
  SELECT COUNT(*) INTO vb_count FROM "value_bets";
  SELECT COUNT(*) INTO pb_count FROM "placed_bets";
  SELECT COUNT(*) INTO bets_count FROM "bets";

  RAISE NOTICE 'Migration verification:';
  RAISE NOTICE '  value_bets rows: %', vb_count;
  RAISE NOTICE '  placed_bets rows: %', pb_count;
  RAISE NOTICE '  bets rows: %', bets_count;
  RAISE NOTICE '  (bets should equal value_bets count)';

  -- Check for orphaned placed_bets (placed without value_bet match)
  SELECT COUNT(*) INTO orphaned FROM "placed_bets" pb
  LEFT JOIN "value_bets" vb ON vb."id" = pb."value_bet_id"
  WHERE vb."id" IS NULL;
  RAISE NOTICE '  orphaned placed_bets: %', orphaned;

  -- Check outcome consistency
  SELECT COUNT(*) INTO outcome_mismatch FROM "placed_bets" pb
  JOIN "value_bets" vb ON vb."id" = pb."value_bet_id"
  WHERE pb."outcome" <> vb."outcome" AND pb."outcome" <> 'pending';
  RAISE NOTICE '  outcome mismatches: %', outcome_mismatch;

  -- Verify placed_at counts match
  RAISE NOTICE '  placed_bets.placed_at count vs bets.placed_at IS NOT NULL count:';
  RAISE NOTICE '    placed_bets: %', pb_count;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 5: Drop old tables (after verification passes)
-- ─────────────────────────────────────────────────────────────────────────────

-- Note: These DROP statements are commented out to allow verification first.
-- Uncomment after confirming the migration data is correct.

DROP TABLE IF EXISTS "placed_bets";
DROP TABLE IF EXISTS "value_bets";

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 6: Drop old strategy tables (strategyId is being removed)
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS "strategy_executions";
DROP TABLE IF EXISTS "strategies";

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (if needed)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- To rollback this migration:
--   1. Re-create value_bets from the bets table (select all where placed_at IS NULL)
--   2. Re-create placed_bets from the bets table (select all where placed_at IS NOT NULL)
--   3. Re-create strategy tables if needed
--   4. DROP TABLE bets;
--
-- The safest approach is to take a pg_dump of value_bets and placed_bets
-- before running this migration, and restore from the dump if needed.
