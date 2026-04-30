-- Drop obsolete betting_settings columns.
-- maxOddsAgeSec: staleness is handled at runtime by MAX_VALUE_ODDS_AGE_MS (180s) in value-detector.ts.
-- Safety rails: were never enforced by any backend code.

ALTER TABLE "betting_settings" DROP COLUMN IF EXISTS "max_odds_age_sec";
ALTER TABLE "betting_settings" DROP COLUMN IF EXISTS "daily_max_loss_bdt";
ALTER TABLE "betting_settings" DROP COLUMN IF EXISTS "daily_max_stake_bdt";
ALTER TABLE "betting_settings" DROP COLUMN IF EXISTS "max_concurrent_exposure_bdt";
ALTER TABLE "betting_settings" DROP COLUMN IF EXISTS "max_bets_per_day";
ALTER TABLE "betting_settings" DROP COLUMN IF EXISTS "cooldown_after_loss_sec";
