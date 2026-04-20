-- Track how many times the settlement pipeline has looked at each bet.
-- A row with `outcome = 'pending'` AND `settle_attempts > 0` means the
-- scheduler has swept it at least once but none of the tiers could
-- resolve it — these are the rows that need human review.
ALTER TABLE "value_bets"
  ADD COLUMN IF NOT EXISTS "settle_attempts" integer NOT NULL DEFAULT 0;

ALTER TABLE "value_bets"
  ADD COLUMN IF NOT EXISTS "last_settle_attempt_at" timestamp with time zone;

-- Partial index so the "needs review" filter is instant even as the
-- attempts column grows over time.
CREATE INDEX IF NOT EXISTS "value_bets_needs_review_idx"
  ON "value_bets" ("last_settle_attempt_at" DESC)
  WHERE "outcome" = 'pending' AND "settle_attempts" > 0;
