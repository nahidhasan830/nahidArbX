-- Add booking points (yellow + 2*red per team) to match_scores cache.
-- Follows the same pattern as corners: NULL until a statistics-capable
-- tier (SofaScore) populates them for batches containing bookings markets.

ALTER TABLE "match_scores"
  ADD COLUMN IF NOT EXISTS "bookings_home" integer;

ALTER TABLE "match_scores"
  ADD COLUMN IF NOT EXISTS "bookings_away" integer;
