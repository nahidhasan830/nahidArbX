-- Bets we have actually PLACED on a soft book via our platform. Distinct
-- from `value_bets`, which stores the detected opportunity. One value bet
-- can produce at most one placed bet (enforced by the lifetime dedup
-- index below — "only one bet per detected (event, family, atom) across
-- all providers").
CREATE TABLE IF NOT EXISTS "placed_bets" (
  "id" text PRIMARY KEY,

  -- Link back to the value bet that triggered the placement. Nullable
  -- because manual placements may predate a value_bet row.
  "value_bet_id" text,

  -- Denormalized from value_bets for fast dedup + querying without a join.
  "event_id" text NOT NULL,
  "family_id" text NOT NULL,
  "atom_id" text NOT NULL,
  "atom_label" text NOT NULL,
  "event_name" text NOT NULL,
  "competition" text,
  "event_start_time" timestamp with time zone NOT NULL,
  "market_type" text NOT NULL,

  -- Placement details.
  "provider" text NOT NULL,              -- which book the bet was placed on
  "stake" numeric(10, 2) NOT NULL,
  "odds" numeric(10, 4) NOT NULL,        -- actual odds booked (may differ from detection-time odds)
  "currency" text NOT NULL DEFAULT 'BDT',
  "provider_ticket_id" text,             -- the book's receipt (if any)
  "mode" text NOT NULL,                  -- 'auto' | 'manual'

  -- Closing-line-value tracking (captured at settlement time from
  -- value_bets.closing_*). Nullable until the event kicks off.
  "closing_odds" numeric(10, 4),
  "clv_pct" numeric(6, 2),

  -- Lifecycle.
  "placed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "outcome" text NOT NULL DEFAULT 'pending', -- 'pending' | 'won' | 'lost' | 'void' | 'half_won' | 'half_lost'
  "pnl" numeric(10, 2),
  "settled_at" timestamp with time zone,
  "settled_by_source" text,

  -- Raw request / response for audit (JSONB so we can query shape changes).
  "request_payload" jsonb,
  "response_payload" jsonb,
  "error" text,

  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Lifetime cross-provider dedup: one placed bet per (event, family, atom).
-- Enforced by a partial unique index that excludes cancelled/error rows
-- so a failed placement doesn't block a retry.
CREATE UNIQUE INDEX IF NOT EXISTS "placed_bets_dedup_idx"
  ON "placed_bets" ("event_id", "family_id", "atom_id")
  WHERE "outcome" <> 'cancelled';

CREATE INDEX IF NOT EXISTS "placed_bets_placed_at_idx"
  ON "placed_bets" ("placed_at" DESC);

CREATE INDEX IF NOT EXISTS "placed_bets_outcome_idx"
  ON "placed_bets" ("outcome")
  WHERE "outcome" <> 'pending';

CREATE INDEX IF NOT EXISTS "placed_bets_provider_idx"
  ON "placed_bets" ("provider");

CREATE INDEX IF NOT EXISTS "placed_bets_value_bet_idx"
  ON "placed_bets" ("value_bet_id")
  WHERE "value_bet_id" IS NOT NULL;
