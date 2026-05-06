ALTER TABLE "bets" ADD COLUMN IF NOT EXISTS "ml_feature_version" integer;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN IF NOT EXISTS "ml_feature_count" integer;--> statement-breakpoint
ALTER TABLE "bets" ADD COLUMN IF NOT EXISTS "ml_feature_names_hash" text;--> statement-breakpoint
ALTER TABLE "ml_models" ALTER COLUMN "feature_count" SET DEFAULT 25;--> statement-breakpoint
ALTER TABLE "ml_models" ADD COLUMN IF NOT EXISTS "feature_version" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "ml_models" ADD COLUMN IF NOT EXISTS "feature_names_hash" text;--> statement-breakpoint

WITH normalized AS (
  SELECT
    id,
    CASE
      WHEN COALESCE(array_length(ml_features, 1), 0) < 25 THEN
        ml_features || ARRAY(
          SELECT CASE gs
            WHEN 22 THEN 1::real
            WHEN 25 THEN 1::real
            ELSE 0::real
          END
          FROM generate_series(COALESCE(array_length(ml_features, 1), 0) + 1, 25) AS gs
        )
      WHEN array_length(ml_features, 1) > 25 THEN ml_features[1:25]
      ELSE ml_features
    END AS normalized_features
  FROM "bets"
  WHERE ml_features IS NOT NULL
)
UPDATE "bets" AS b
SET
  ml_features = n.normalized_features,
  ml_feature_version = 2,
  ml_feature_count = 25,
  ml_feature_names_hash = '5a3c08405a8444ea5621708ccd7e17933dfd2270d04e37ab503f4b71847cf1f7'
FROM normalized AS n
WHERE b.id = n.id
  AND array_length(n.normalized_features, 1) = 25;--> statement-breakpoint

UPDATE "ml_models"
SET feature_names_hash = '5a3c08405a8444ea5621708ccd7e17933dfd2270d04e37ab503f4b71847cf1f7'
WHERE feature_count = 25
  AND feature_names_hash IS NULL;
