-- Promote placed_bets_dedup_idx from a non-unique index to a partial
-- UNIQUE index. The schema comment always claimed uniqueness was
-- enforced, but the underlying index was non-unique, leaving the
-- SELECT-then-INSERT path in placer.ts open to a race: three concurrent
-- auto-placements for the same (event, family, atom) all passed
-- isAlreadyPlaced, all submitted to the book, the book deduplicated
-- them to a single ticket id, and reconciler then attached that one
-- ticket id to all three duplicate rows — operator saw N identical
-- "Bet Placed" Telegrams.
--
-- Pair of fixes (matching schema.ts + placer.ts):
--   1. In-process inflight lock in placer.ts (prevents the common race)
--   2. This UNIQUE index (backstop for multi-process / HMR / restart
--      race windows)
DROP INDEX IF EXISTS "placed_bets_dedup_idx";

CREATE UNIQUE INDEX "placed_bets_dedup_idx"
  ON "placed_bets" ("event_id", "family_id", "atom_id")
  WHERE "outcome" <> 'cancelled';
