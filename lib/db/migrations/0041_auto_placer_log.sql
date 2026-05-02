CREATE TABLE "auto_placer_log" (
  "id" bigserial PRIMARY KEY,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "bet_id" text NOT NULL,
  "gate" text NOT NULL,
  "status" text NOT NULL,
  "reason" text,
  "soft_provider" text NOT NULL,
  "home_team" text,
  "away_team" text,
  "competition" text,
  "event_start_time" timestamp with time zone,
  "market_type" text,
  "atom_label" text,
  "soft_odds" numeric(10, 4),
  "sharp_odds" numeric(10, 4),
  "ev_pct" numeric(6, 2),
  "ml_score" real,
  "stake" numeric(10, 2),
  "balance" numeric(10, 2),
  "booked_odds" numeric(10, 4),
  "ticket_id" text
);

CREATE INDEX "auto_placer_log_created_idx" ON "auto_placer_log" ("created_at" DESC);
CREATE INDEX "auto_placer_log_bet_idx" ON "auto_placer_log" ("bet_id");
CREATE INDEX "auto_placer_log_status_idx" ON "auto_placer_log" ("status");
CREATE INDEX "auto_placer_log_provider_idx" ON "auto_placer_log" ("soft_provider");
