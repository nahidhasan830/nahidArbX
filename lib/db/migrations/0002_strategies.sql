CREATE TABLE IF NOT EXISTS "strategies" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "filters" jsonb NOT NULL,
  "stake_multiplier" numeric(6, 3) NOT NULL DEFAULT '1',
  "origin" text NOT NULL DEFAULT 'manual',
  "rationale" text,
  "status" text NOT NULL DEFAULT 'candidate',
  "metrics_snapshot" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "strategies_status_idx" ON "strategies" ("status");
CREATE INDEX IF NOT EXISTS "strategies_origin_idx" ON "strategies" ("origin");
