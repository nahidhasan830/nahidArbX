import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import { ML_FEATURE_COUNT, ML_FEATURE_VERSION } from "@/lib/shared/constants";
import { FEATURE_NAMES_HASH } from "@/lib/ml/features";

export interface TrainingSampleAccounting {
  qualifiedBets: number;
  rawLabeledExamples: number;
  canonicalExamples: number;
  canonicalExamplesWithSourceBet: number;
  uncoveredQualifiedBets: number;
  trainerExpectedSamples: number;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return 0;
}

export async function getTrainingSampleAccounting(
  db: Db,
): Promise<TrainingSampleAccounting> {
  const result = await db.execute(sql`
    WITH canonical AS (
      WITH eligible AS (
        SELECT
          m.source_bet_id,
          m.example_type,
          m.event_id,
          m.family_id,
          m.atom_id,
          m.settled_at,
          m.created_at
        FROM ml_training_examples m
        WHERE m.label IN ('positive', 'negative')
          AND m.features IS NOT NULL
          AND m.feature_version = ${ML_FEATURE_VERSION}
          AND array_length(m.features, 1) = ${ML_FEATURE_COUNT}
          AND m.features[2] > 0
          AND m.features[2] < 1
          AND m.features[4] > 1.01
          AND m.features[22] IN (1.0, 2.0, 3.0)
      ),
      ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(source_bet_id, event_id || '|' || family_id || '|' || atom_id)
            ORDER BY
              CASE example_type
                WHEN 'placed_settled' THEN 4
                WHEN 'settled_detected' THEN 3
                WHEN 'shadow_scored' THEN 2
                ELSE 0
              END DESC,
              CASE WHEN settled_at IS NOT NULL THEN 1 ELSE 0 END DESC,
              COALESCE(settled_at, created_at) DESC
          ) AS rn
        FROM eligible
      )
      SELECT source_bet_id, example_type
      FROM ranked
      WHERE rn = 1
    ),
    qualified AS (
      SELECT id
      FROM bets
      WHERE outcome NOT IN ('pending', 'void')
        AND ml_features IS NOT NULL
        AND ml_feature_version = ${ML_FEATURE_VERSION}
        AND ml_feature_names_hash = ${FEATURE_NAMES_HASH}
        AND array_length(ml_features, 1) = ${ML_FEATURE_COUNT}
        AND sharp_true_prob > 0
        AND sharp_true_prob < 1
        AND soft_odds > 1.01
        AND ml_features[22] IN (1.0, 2.0, 3.0)
    )
    SELECT
      (SELECT count(*)::int FROM qualified) AS qualified_bets,
      (SELECT count(*)::int FROM ml_training_examples WHERE label IN ('positive', 'negative')) AS raw_labeled_examples,
      (SELECT count(*)::int FROM canonical) AS canonical_examples,
      (SELECT count(*)::int FROM canonical WHERE source_bet_id IS NOT NULL) AS canonical_examples_with_source_bet,
      (SELECT count(*)::int FROM qualified q WHERE NOT EXISTS (SELECT 1 FROM canonical c WHERE c.source_bet_id = q.id)) AS uncovered_qualified_bets
  `);

  const row = result.rows[0] as Record<string, unknown>;
  const canonicalExamples = toNumber(row.canonical_examples);
  const uncoveredQualifiedBets = toNumber(row.uncovered_qualified_bets);

  return {
    qualifiedBets: toNumber(row.qualified_bets),
    rawLabeledExamples: toNumber(row.raw_labeled_examples),
    canonicalExamples,
    canonicalExamplesWithSourceBet: toNumber(
      row.canonical_examples_with_source_bet,
    ),
    uncoveredQualifiedBets,
    trainerExpectedSamples:
      canonicalExamples > 0 ? canonicalExamples : uncoveredQualifiedBets,
  };
}
