ALTER TABLE "bets" ADD COLUMN "ml_features" real[];--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "ml_score" real;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN "ml_kelly_adjusted" real;--> statement-breakpoint
ALTER TABLE "betting_settings" ADD COLUMN "ml_min_score" numeric(4, 2) DEFAULT 0.4 NOT NULL;--> statement-breakpoint
CREATE TABLE "ml_models" (
	"id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'training' NOT NULL,
	"model_type" text DEFAULT 'lightgbm' NOT NULL,
	"training_samples" integer NOT NULL,
	"feature_count" integer DEFAULT 23 NOT NULL,
	"training_started_at" timestamp with time zone NOT NULL,
	"training_completed_at" timestamp with time zone,
	"oos_roi_mean" numeric(14, 4),
	"oos_accuracy" numeric(6, 4),
	"oos_auc_roc" numeric(6, 4),
	"oos_log_loss" numeric(8, 6),
	"deflated_sharpe" numeric(14, 4),
	"pbo" numeric(6, 4),
	"calibration_error" numeric(8, 6),
	"feature_importance" jsonb,
	"model_artifact_path" text,
	"training_report" jsonb,
	"deployed_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "ml_models_status_idx" ON "ml_models" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ml_models_deployed_idx" ON "ml_models" USING btree ("deployed_at" DESC NULLS LAST) WHERE "ml_models"."status" = 'deployed';
