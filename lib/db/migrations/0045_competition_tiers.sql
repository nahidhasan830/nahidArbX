CREATE TABLE IF NOT EXISTS "competition_tiers" (
	"name" text PRIMARY KEY NOT NULL,
	"tier" integer NOT NULL,
	"classified_at" timestamp with time zone DEFAULT now() NOT NULL
);
