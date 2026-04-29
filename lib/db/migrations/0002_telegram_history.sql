CREATE TABLE IF NOT EXISTS "telegram_command_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"command" text NOT NULL,
	"text" text NOT NULL,
	"from_user_id" integer,
	"outcome" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_history_at_idx" ON "telegram_command_history" USING btree ("at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_history_command_idx" ON "telegram_command_history" USING btree ("command");