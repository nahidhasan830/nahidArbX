ALTER TABLE "value_bets" ADD COLUMN "is_dummy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "value_bets_is_dummy_idx" ON "value_bets" USING btree ("is_dummy");