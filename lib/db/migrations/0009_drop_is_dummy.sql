-- Retire the is_dummy column on value_bets. We now rely solely on real
-- value-bet rows produced by the live pipeline; the dummy seed is gone.
-- Idempotent: both the index and the column drop use IF EXISTS.
DROP INDEX IF EXISTS "value_bets_is_dummy_idx";
ALTER TABLE "value_bets" DROP COLUMN IF EXISTS "is_dummy";
