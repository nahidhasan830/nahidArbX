-- AlphaSearch — "run started" Telegram notification idempotency stamp.
--
-- Parallel to `notified_at` (which guards the "run completed" ping), this
-- column guards the "run started" ping so the notifier tick fires exactly
-- once per run transition from queued → running.
--
-- Fired from lib/optimizer/notifier-tick.ts — claim query:
--   SELECT … FROM optimization_runs
--   WHERE status IN ('running','completed','failed','cancelled')
--     AND notify_on_complete = true
--     AND started_at IS NOT NULL
--     AND started_notified_at IS NULL
-- The message payload includes: name, algorithm, trials, CV strategy,
-- estimated finish time (derived from historical p50 durations), bet count,
-- and a data-scope summary — so the operator knows what's cooking the moment
-- the sidecar picks the run up.

ALTER TABLE "optimization_runs"
  ADD COLUMN IF NOT EXISTS "started_notified_at" timestamp with time zone;

-- Hot-path index for the notifier tick's "run started" claim query. We also
-- include status='running' in the terminal list so an opt-in-at-start ping
-- fires even if the run completes before the next tick.
CREATE INDEX IF NOT EXISTS "optimization_runs_started_notify_pending_idx"
  ON "optimization_runs" ("started_at")
  WHERE "notify_on_complete" = true
    AND "started_at" IS NOT NULL
    AND "started_notified_at" IS NULL;
