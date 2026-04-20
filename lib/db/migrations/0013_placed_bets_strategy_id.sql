-- Link placed bets back to the strategy (if any) that caused the auto-
-- placement. Nullable: manual placements and bets placed before any
-- strategies existed won't have one. Enables per-strategy live ROI/CLV
-- reporting — the forward-test counterpart to strategy backtest metrics.
ALTER TABLE "placed_bets"
  ADD COLUMN IF NOT EXISTS "strategy_id" text;

CREATE INDEX IF NOT EXISTS "placed_bets_strategy_idx"
  ON "placed_bets" ("strategy_id")
  WHERE "strategy_id" IS NOT NULL;
