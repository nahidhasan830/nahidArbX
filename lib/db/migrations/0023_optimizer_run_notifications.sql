-- AlphaSearch — per-run Telegram notification.
--
-- When a run transitions to a terminal status (completed | failed | cancelled),
-- the notifier tick (lib/optimizer/notifier-tick.ts) fires a single Telegram
-- message with the run summary + best-trial metrics and stamps notified_at.
--
-- `notify_on_complete` controls whether the ping is wanted at all:
--   * Manual runs submitted through the UI default to TRUE (the UI also exposes
--     the switch so the user can opt out).
--   * Scheduled runs inherit this flag from `optimization_schedules.notify_on_complete`
--     at firing time (see lib/optimizer/scheduler.ts fireDueSchedules).
-- `notified_at` is null until the tick fires; it's the idempotency key — the
-- same tick never sends twice for one run.

ALTER TABLE "optimization_runs"
  ADD COLUMN IF NOT EXISTS "notify_on_complete" boolean NOT NULL DEFAULT true;

ALTER TABLE "optimization_runs"
  ADD COLUMN IF NOT EXISTS "notified_at" timestamp with time zone;

-- Hot-path index for the notifier tick's claim query:
--   SELECT … FROM optimization_runs
--   WHERE status IN ('completed','failed','cancelled')
--     AND notify_on_complete = true
--     AND notified_at IS NULL
CREATE INDEX IF NOT EXISTS "optimization_runs_notify_pending_idx"
  ON "optimization_runs" ("completed_at")
  WHERE "notify_on_complete" = true
    AND "notified_at" IS NULL
    AND "status" IN ('completed', 'failed', 'cancelled');
