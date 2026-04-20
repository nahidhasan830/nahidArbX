CREATE TABLE "value_bets" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"family_id" text NOT NULL,
	"atom_id" text NOT NULL,
	"atom_label" text NOT NULL,
	"home_team" text NOT NULL,
	"away_team" text NOT NULL,
	"competition" text,
	"event_start_time" timestamp with time zone NOT NULL,
	"match_confidence" numeric(4, 3),
	"market_type" text NOT NULL,
	"time_scope" text NOT NULL,
	"family_line" numeric(5, 2),
	"sharp_provider" text NOT NULL,
	"sharp_odds" numeric(10, 4) NOT NULL,
	"sharp_true_prob" numeric(6, 5) NOT NULL,
	"sharp_odds_age_ms" integer,
	"soft_provider" text NOT NULL,
	"soft_commission_pct" numeric(5, 2) NOT NULL,
	"soft_odds_first" numeric(10, 4) NOT NULL,
	"soft_odds_last" numeric(10, 4) NOT NULL,
	"soft_odds_max" numeric(10, 4) NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"tick_count" integer DEFAULT 1 NOT NULL,
	"closing_sharp_odds" numeric(10, 4),
	"closing_soft_odds" numeric(10, 4),
	"closing_captured_at" timestamp with time zone,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"outcome_marked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "value_bets_first_seen_idx" ON "value_bets" USING btree ("first_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "value_bets_market_idx" ON "value_bets" USING btree ("market_type","time_scope");--> statement-breakpoint
CREATE INDEX "value_bets_soft_idx" ON "value_bets" USING btree ("soft_provider");--> statement-breakpoint
CREATE INDEX "value_bets_soft_odds_max_idx" ON "value_bets" USING btree ("soft_odds_max" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "value_bets_outcome_idx" ON "value_bets" USING btree ("outcome") WHERE "value_bets"."outcome" <> 'pending';--> statement-breakpoint
CREATE INDEX "value_bets_event_start_idx" ON "value_bets" USING btree ("event_start_time");