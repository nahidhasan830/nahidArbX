import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  ML_COLD_START_THRESHOLD,
  ML_COLLECTION_TARGET,
  ML_FEATURE_COUNT,
  ML_FEATURE_VERSION,
} from "@/lib/shared/constants";
import {
  FEATURE_NAMES_HASH,
  FEATURE_SQL_INDEX,
} from "@/lib/ml/feature-contract";

export interface CanonicalTrainingExampleRow {
  sourceBetId: string | null;
  exampleType: string;
}

export interface CurrentCorpusDailyHistoryRow {
  day: string;
  totalSettled: number;
  currentContractFeatures: number;
  wins: number;
  losses: number;
}

export interface CurrentCorpusAccounting {
  totalSettled: number;
  currentContractFeatures: number;
  wins: number;
  losses: number;
  coldStartThreshold: number;
  collectionTarget: number;
  remainingToColdStart: number;
  remainingToTarget: number;
  dailyHistory: CurrentCorpusDailyHistoryRow[];
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

const TRAINING_EXAMPLE_SHARP_PROB_SQL_INDEX = FEATURE_SQL_INDEX.sharp_true_prob;
const TRAINING_EXAMPLE_ADJUSTED_ODDS_SQL_INDEX =
  FEATURE_SQL_INDEX.adjusted_soft_odds;
const TRAINING_EXAMPLE_COMPETITION_TIER_SQL_INDEX =
  FEATURE_SQL_INDEX.competition_tier;
const BET_COMPETITION_TIER_SQL_INDEX = FEATURE_SQL_INDEX.competition_tier;

const CANONICAL_TRAINING_EXAMPLES_SQL = sql`
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
      AND m.features[${TRAINING_EXAMPLE_SHARP_PROB_SQL_INDEX}] > 0
      AND m.features[${TRAINING_EXAMPLE_SHARP_PROB_SQL_INDEX}] < 1
      AND m.features[${TRAINING_EXAMPLE_ADJUSTED_ODDS_SQL_INDEX}] > 1.01
      AND m.features[${TRAINING_EXAMPLE_COMPETITION_TIER_SQL_INDEX}] IN (1.0, 2.0, 3.0)
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
`;

function mapCanonicalTrainingExampleRows(
  rows: Record<string, unknown>[],
): CanonicalTrainingExampleRow[] {
  return rows.map((row) => ({
    sourceBetId:
      typeof row.source_bet_id === "string" ? row.source_bet_id : null,
    exampleType: String(row.example_type ?? ""),
  }));
}

export async function getCanonicalTrainingExampleRows(
  db: Db,
): Promise<CanonicalTrainingExampleRow[]> {
  const result = await db.execute(CANONICAL_TRAINING_EXAMPLES_SQL);

  return mapCanonicalTrainingExampleRows(
    result.rows as Record<string, unknown>[],
  );
}

export async function getCurrentCorpusAccounting(
  db: Db,
): Promise<CurrentCorpusAccounting> {
  const result = await db.execute(sql`
    WITH canonical AS (${CANONICAL_TRAINING_EXAMPLES_SQL}),
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
        AND ml_features[${BET_COMPETITION_TIER_SQL_INDEX}] IN (1.0, 2.0, 3.0)
    )
    SELECT
      (SELECT count(*)::int FROM bets WHERE outcome NOT IN ('pending', 'void')) AS total_settled,
      (SELECT count(*)::int FROM bets WHERE outcome NOT IN ('pending', 'void') AND ml_feature_version = ${ML_FEATURE_VERSION}) AS current_contract_features,
      (SELECT count(*)::int FROM bets WHERE outcome NOT IN ('pending', 'void') AND outcome IN ('won', 'half_won')) AS wins,
      (SELECT count(*)::int FROM bets WHERE outcome NOT IN ('pending', 'void') AND outcome IN ('lost', 'half_lost')) AS losses,
      (SELECT count(*)::int FROM qualified) AS qualified_bets,
      (SELECT count(*)::int FROM ml_training_examples WHERE label IN ('positive', 'negative')) AS raw_labeled_examples,
      (SELECT count(*)::int FROM canonical) AS canonical_examples,
      (SELECT count(*)::int FROM canonical WHERE source_bet_id IS NOT NULL) AS canonical_examples_with_source_bet,
      (SELECT count(*)::int FROM qualified q WHERE NOT EXISTS (SELECT 1 FROM canonical c WHERE c.source_bet_id = q.id)) AS uncovered_qualified_bets
  `);

  const dailyHistoryResult = await db.execute(sql`
    SELECT
      date_trunc('day', settled_at)::date::text AS day,
      count(*)::int AS total_settled,
      count(*) FILTER (WHERE ml_feature_version = ${ML_FEATURE_VERSION})::int AS current_contract_features,
      count(*) FILTER (WHERE outcome IN ('won', 'half_won'))::int AS wins,
      count(*) FILTER (WHERE outcome IN ('lost', 'half_lost'))::int AS losses
    FROM bets
    WHERE outcome NOT IN ('pending', 'void')
      AND settled_at >= current_date - interval '13 days'
    GROUP BY day
    ORDER BY day ASC
  `);

  const row = result.rows[0] as Record<string, unknown>;
  const currentContractFeatures = toNumber(row.current_contract_features);
  const canonicalExamples = toNumber(row.canonical_examples);
  const uncoveredQualifiedBets = toNumber(row.uncovered_qualified_bets);

  return {
    totalSettled: toNumber(row.total_settled),
    currentContractFeatures,
    wins: toNumber(row.wins),
    losses: toNumber(row.losses),
    coldStartThreshold: ML_COLD_START_THRESHOLD,
    collectionTarget: ML_COLLECTION_TARGET,
    remainingToColdStart: Math.max(
      0,
      ML_COLD_START_THRESHOLD - currentContractFeatures,
    ),
    remainingToTarget: Math.max(
      0,
      ML_COLLECTION_TARGET - currentContractFeatures,
    ),
    dailyHistory: dailyHistoryResult.rows.map((dailyRow) => {
      const r = dailyRow as Record<string, unknown>;
      return {
        day: String(r.day ?? ""),
        totalSettled: toNumber(r.total_settled),
        currentContractFeatures: toNumber(r.current_contract_features),
        wins: toNumber(r.wins),
        losses: toNumber(r.losses),
      };
    }),
    qualifiedBets: toNumber(row.qualified_bets),
    rawLabeledExamples: toNumber(row.raw_labeled_examples),
    canonicalExamples,
    canonicalExamplesWithSourceBet: toNumber(
      row.canonical_examples_with_source_bet,
    ),
    uncoveredQualifiedBets,
    trainerExpectedSamples: canonicalExamples + uncoveredQualifiedBets,
  };
}
