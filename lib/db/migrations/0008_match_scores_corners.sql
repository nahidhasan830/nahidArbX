-- Extend match_scores with corner counts so we can settle CORNERS,
-- HOME/AWAY_CORNERS_TOTAL, and CORNERS_HANDICAP markets deterministically.
-- Corners are optional (NULL when not fetched / source lacks stats).
ALTER TABLE "match_scores" ADD COLUMN IF NOT EXISTS "corners_home"    integer;
ALTER TABLE "match_scores" ADD COLUMN IF NOT EXISTS "corners_away"    integer;
ALTER TABLE "match_scores" ADD COLUMN IF NOT EXISTS "ht_corners_home" integer;
ALTER TABLE "match_scores" ADD COLUMN IF NOT EXISTS "ht_corners_away" integer;
