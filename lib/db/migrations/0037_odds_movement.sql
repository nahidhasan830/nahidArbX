-- Add odds_movement JSONB column to bets table.
-- Stores the Pinnacle line movement snapshot (opening, peak, trough, sparkline)
-- captured at value bet detection/update time.
ALTER TABLE "bets" ADD COLUMN IF NOT EXISTS "odds_movement" jsonb;
