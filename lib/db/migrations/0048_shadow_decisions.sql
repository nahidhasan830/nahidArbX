-- Shadow mode: per-bet tracking of shadow Kelly vs ML Kelly decisions.
-- Enables post-hoc analysis of shadow-mode performance vs real auto-placer.
--
-- Shadow decisions are created when a bet is placed (reactive detector).
-- They are resolved when the settlement run marks the corresponding bet.

CREATE TABLE IF NOT EXISTS shadow_decisions (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  bet_id       text         NOT NULL,
  event_id     text         NOT NULL,
  placed_at    timestamptz  NOT NULL,
  kelly_raw    real         NOT NULL,   -- raw Kelly fraction
  shadow_kelly real         NOT NULL,   -- kelly_raw * 0.5
  ml_kelly     real         NOT NULL,   -- computeAdjustedKelly output
  ml_multiplier real        NOT NULL,   -- ml_kelly / kelly_raw
  outcome      text         NULL,       -- settled outcome (null=unresolved)
  settled_at   timestamptz  NULL,
  created_at   timestamptz  NOT NULL DEFAULT now()
);

-- Index for batch resolution: find all unresolved shadow decisions for an event.
CREATE INDEX IF NOT EXISTS shadow_decisions_event_idx ON shadow_decisions(event_id, outcome) WHERE outcome IS NULL;

-- Index for per-bet lookup.
CREATE INDEX IF NOT EXISTS shadow_decisions_bet_idx    ON shadow_decisions(bet_id);

-- Index for time-series analysis.
CREATE INDEX IF NOT EXISTS shadow_decisions_placed_idx ON shadow_decisions(placed_at DESC);
