-- Global betting settings — singleton row keyed by id=1. Drives all
-- auto-placement sizing, strategy choice, and safety rails. Written
-- by the /api/betting-settings PUT endpoint. Read path is memoized
-- in-process so placement-path reads cost a Map lookup, not a query.
--
-- Strategy id values are 1:1 with the backtest STRATEGIES array in
-- lib/backtest/analyze.ts to avoid keeping two lists in sync.
CREATE TABLE IF NOT EXISTS "betting_settings" (
  "id"                          integer PRIMARY KEY DEFAULT 1,
  "strategy_id"                 text           NOT NULL DEFAULT 'frac-kelly-0.25',
  "use_live_balance"            boolean        NOT NULL DEFAULT true,
  "manual_bankroll_bdt"         numeric(12, 2) NOT NULL DEFAULT 1000,
  "unit_size_bdt"               numeric(10, 2) NOT NULL DEFAULT 200,
  "kelly_cap_pct"               numeric(5, 2)  NOT NULL DEFAULT 10,
  "min_stake_bdt"               numeric(10, 2) NOT NULL DEFAULT 200,
  "stake_bucket_bdt"            numeric(10, 2) NOT NULL DEFAULT 100,
  "min_ev_pct"                  numeric(5, 2)  NOT NULL DEFAULT 2,
  "max_odds_age_sec"            integer        NOT NULL DEFAULT 90,
  "daily_max_loss_bdt"          numeric(12, 2),
  "daily_max_stake_bdt"         numeric(12, 2),
  "max_concurrent_exposure_bdt" numeric(12, 2),
  "max_bets_per_day"            integer,
  "cooldown_after_loss_sec"     integer,
  "updated_at"                  timestamptz    NOT NULL DEFAULT now()
);

-- Seed the singleton row so readers never hit an empty table on first
-- boot. ON CONFLICT DO NOTHING so re-running the migration after the
-- app has already written settings is a no-op.
INSERT INTO "betting_settings" ("id") VALUES (1)
  ON CONFLICT ("id") DO NOTHING;
