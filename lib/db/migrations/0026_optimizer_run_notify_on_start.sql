-- AlphaSearch — split the "run started" and "run completed" Telegram toggles.
--
-- Until now, `notify_on_complete` gated BOTH pings (started + terminal).
-- Operators asked for independent control — they want to know the moment a
-- run picks up (for big sweeps whose ETA matters) without the completion
-- ping, or vice versa. This migration adds a dedicated `notify_on_start`
-- column and rebuilds the "run started" claim index around it.
--
-- Backward-compat: defaults to TRUE. The old behaviour for existing rows
-- becomes "both pings fire" — same as today. New UI surfaces both toggles
-- independently; defaults on for both.
--
-- `optimization_schedules` also gets the column so scheduled runs can
-- inherit the preference the same way they inherit `notify_on_complete`.

ALTER TABLE "optimization_runs"
  ADD COLUMN IF NOT EXISTS "notify_on_start" boolean NOT NULL DEFAULT true;

ALTER TABLE "optimization_schedules"
  ADD COLUMN IF NOT EXISTS "notify_on_start" boolean NOT NULL DEFAULT false;

-- Rebuild the hot-path index for the notifier tick's "run started" claim
-- query — it now keys off `notify_on_start`, not `notify_on_complete`.
DROP INDEX IF EXISTS "optimization_runs_started_notify_pending_idx";
CREATE INDEX IF NOT EXISTS "optimization_runs_started_notify_pending_idx"
  ON "optimization_runs" ("started_at")
  WHERE "notify_on_start" = true
    AND "started_at" IS NOT NULL
    AND "started_notified_at" IS NULL;
