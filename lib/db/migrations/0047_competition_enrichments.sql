CREATE TABLE IF NOT EXISTS "competition_enrichments" (
	"name" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"tier" integer DEFAULT 1 NOT NULL,
	"market_efficiency_score" integer DEFAULT 0 NOT NULL,
	"region" text,
	"country" text,
	"competition_level" text DEFAULT 'unknown' NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"model" text,
	"provider" text,
	"prompt_version" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_response" jsonb,
	"classified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "competition_enrichments_confidence_idx" ON "competition_enrichments" ("confidence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "competition_enrichments_classified_idx" ON "competition_enrichments" ("classified_at" DESC);
--> statement-breakpoint
INSERT INTO "competition_enrichments" (
	"name",
	"display_name",
	"tier",
	"market_efficiency_score",
	"competition_level",
	"confidence",
	"provider",
	"prompt_version",
	"sources",
	"raw_response",
	"classified_at",
	"updated_at"
)
SELECT
	lower(regexp_replace(trim("name"), '\s+', ' ', 'g')),
	"name",
	"tier",
	CASE
		WHEN "tier" = 3 THEN 85
		WHEN "tier" = 2 THEN 60
		ELSE 30
	END,
	'unknown',
	50,
	'legacy',
	'competition-enrichment-v1',
	'[]'::jsonb,
	jsonb_build_object('competition_tiers', jsonb_build_object('name', "name", 'tier', "tier")),
	"classified_at",
	now()
FROM "competition_tiers"
ON CONFLICT ("name") DO NOTHING;
