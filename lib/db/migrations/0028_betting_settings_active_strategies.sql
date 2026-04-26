-- Active strategies field on the singleton betting_settings row.
-- When non-empty, the auto-placer ONLY places bets that match at least
-- one of the listed strategies' filters. Empty (default) preserves the
-- pre-strategy behavior — every bet that passes the global EV cutoff +
-- per-provider auto-place toggle gets placed.
ALTER TABLE betting_settings
  ADD COLUMN IF NOT EXISTS active_strategy_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
