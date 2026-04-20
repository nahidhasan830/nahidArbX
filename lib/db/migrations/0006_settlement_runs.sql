-- Per-tick telemetry from the continuous auto-settle loop. Lets us chart
-- cost + tier-hit distribution + failures over time without grepping logs.
CREATE TABLE IF NOT EXISTS "settlement_runs" (
  "id"                         text PRIMARY KEY NOT NULL,
  "started_at"                 timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at"                timestamp with time zone,
  "duration_ms"                integer,
  "scanned_bets"               integer NOT NULL DEFAULT 0,
  "unique_events"              integer NOT NULL DEFAULT 0,
  "settled_deterministically"  integer NOT NULL DEFAULT 0,
  "applied"                    integer NOT NULL DEFAULT 0,
  "still_pending"              integer NOT NULL DEFAULT 0,
  "tier0_hits"                 integer NOT NULL DEFAULT 0,
  "tier1_hits"                 integer NOT NULL DEFAULT 0,
  "tier2_hits"                 integer NOT NULL DEFAULT 0,
  "tier3_hits"                 integer NOT NULL DEFAULT 0,
  "tier4_hits"                 integer NOT NULL DEFAULT 0,
  "unresolved_events"          integer NOT NULL DEFAULT 0,
  "aborted_reason"             text,
  "error"                      text,
  "estimated_cost_usd"         numeric(8, 5)
);

CREATE INDEX IF NOT EXISTS "settlement_runs_started_idx"
  ON "settlement_runs" ("started_at" DESC);
