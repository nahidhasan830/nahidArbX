ALTER TABLE "betting_settings" ADD COLUMN "auto_settle_force_ai" boolean DEFAULT false NOT NULL;
ALTER TABLE "betting_settings" ADD COLUMN "auto_settle_ai_model" text DEFAULT 'lite' NOT NULL;