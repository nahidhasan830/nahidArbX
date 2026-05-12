/**
 * GET /api/ml/training-data — returns all qualified bets for ML training.
 *
 * "Qualified" = settled (non-pending, non-void) + has ML features at the
 * current FEATURE_VERSION. Each row indicates whether it is covered by
 * a canonical current-version training example.
 *
 * Phase 2: covered means covered by a labeled, current-version
 * training example — not just any row with the same source_bet_id.
 *
 * Used by the Training Data DataTable on the ML Optimizer dashboard.
 */
import { NextResponse } from "next/server";
import { sql, and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bets, mlModels, mlTrainingExamples } from "@/lib/db/schema";
import { ML_FEATURE_VERSION, ML_FEATURE_COUNT } from "@/lib/shared/constants";
import { FEATURE_NAMES_HASH } from "@/lib/ml/features";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export interface TrainingDataRow {
  id: string;
  homeTeam: string;
  awayTeam: string;
  competition: string | null;
  marketType: string;
  atomLabel: string;
  outcome: string;
  pnl: number | null;
  clvPct: number | null;
  mlScore: number | null;
  featureVersion: number | null;
  featureCount: number | null;
  firstSeenAt: string;
  settledAt: string | null;
  coveredByCorpus: boolean;
  /** Phase 2: The example type that covers this bet, if any. */
  exampleType: string | null;
}

async function getCanonicalTrainingExampleRows(): Promise<
  Array<{ sourceBetId: string | null; exampleType: string }>
> {
  const result = await db.execute(sql`
    WITH eligible AS (
      SELECT
        m.source_bet_id,
        m.example_type,
        m.event_id,
        m.family_id,
        m.atom_id,
        m.settled_at,
        m.created_at
      FROM ${mlTrainingExamples} m
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
  `);

  return result.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      sourceBetId: typeof r.source_bet_id === "string" ? r.source_bet_id : null,
      exampleType: String(r.example_type ?? ""),
    };
  });
}

export async function GET() {
  try {
    // 1. Get all trained bet IDs from ml_training_examples
    //    Phase 2: Only count labeled rows at current feature version
    const trainedRows = await getCanonicalTrainingExampleRows();

    // Build a map: betId → exampleType (keep highest-precedence type)
    const trainedMap = new Map<string, string>();
    const PRECEDENCE: Record<string, number> = {
      placed_settled: 4,
      settled_detected: 3,
      shadow_scored: 2,
    };
    for (const r of trainedRows) {
      if (!r.sourceBetId) continue;
      const existing = trainedMap.get(r.sourceBetId);
      const existingPrecedence = existing ? (PRECEDENCE[existing] ?? 0) : 0;
      const candidatePrecedence = PRECEDENCE[r.exampleType] ?? 0;
      if (candidatePrecedence > existingPrecedence) {
        trainedMap.set(r.sourceBetId, r.exampleType);
      }
    }

    // 2. Get all qualified bets (settled + has features at current version)
    const qualifiedBets = await db
      .select({
        id: bets.id,
        homeTeam: bets.homeTeam,
        awayTeam: bets.awayTeam,
        competition: bets.competition,
        marketType: bets.marketType,
        atomLabel: bets.atomLabel,
        outcome: bets.outcome,
        pnl: bets.pnl,
        clvPct: bets.clvPct,
        mlScore: bets.mlScore,
        featureVersion: bets.mlFeatureVersion,
        featureCount: bets.mlFeatureCount,
        firstSeenAt: bets.firstSeenAt,
        settledAt: bets.settledAt,
      })
      .from(bets)
      .where(
        and(
          sql`${bets.outcome} NOT IN ('pending', 'void')`,
          isNotNull(bets.mlFeatures),
          sql`${bets.mlFeatureVersion} = ${ML_FEATURE_VERSION}`,
          sql`${bets.mlFeatureNamesHash} = ${FEATURE_NAMES_HASH}`,
          sql`array_length(${bets.mlFeatures}, 1) = ${ML_FEATURE_COUNT}`,
          sql`(${bets.mlFeatures})[22] IN (1.0, 2.0, 3.0)`,
          sql`${bets.sharpTrueProb} > 0`,
          sql`${bets.sharpTrueProb} < 1`,
          sql`${bets.softOdds} > 1.01`,
        ),
      )
      .orderBy(bets.firstSeenAt);

    // 3. Map to response format with corpus coverage flag
    const rows: TrainingDataRow[] = qualifiedBets.map((b) => ({
      id: b.id,
      homeTeam: b.homeTeam,
      awayTeam: b.awayTeam,
      competition: b.competition,
      marketType: b.marketType,
      atomLabel: b.atomLabel,
      outcome: b.outcome,
      pnl: b.pnl,
      clvPct: b.clvPct,
      mlScore: b.mlScore,
      featureVersion: b.featureVersion,
      featureCount: b.featureCount,
      firstSeenAt: b.firstSeenAt,
      settledAt: b.settledAt,
      coveredByCorpus: trainedMap.has(b.id),
      exampleType: trainedMap.get(b.id) ?? null,
    }));

    // Summary counts
    const corpusCovered = rows.filter((r) => r.coveredByCorpus).length;
    const uncoveredQualifiedBets = rows.filter(
      (r) => !r.coveredByCorpus,
    ).length;
    const canonicalExamples = trainedRows.length;
    const trainerExpectedSamples =
      canonicalExamples > 0 ? canonicalExamples : uncoveredQualifiedBets;
    const [[latestModel], [deployedModel]] = await Promise.all([
      db
        .select({
          version: mlModels.version,
          status: mlModels.status,
          trainingSamples: mlModels.trainingSamples,
          createdAt: mlModels.createdAt,
        })
        .from(mlModels)
        .orderBy(desc(mlModels.createdAt))
        .limit(1),
      db
        .select({
          version: mlModels.version,
          status: mlModels.status,
          trainingSamples: mlModels.trainingSamples,
          createdAt: mlModels.createdAt,
        })
        .from(mlModels)
        .where(eq(mlModels.status, "deployed"))
        .orderBy(desc(mlModels.deployedAt))
        .limit(1),
    ]);

    return NextResponse.json({
      rows,
      summary: {
        total: rows.length,
        corpusCovered,
        uncoveredQualifiedBets,
        canonicalExamples,
        trainerExpectedSamples,
        latestModelVersion: latestModel?.version ?? null,
        latestModelStatus: latestModel?.status ?? null,
        latestModelTrainingSamples: latestModel?.trainingSamples ?? null,
        deployedModelVersion: deployedModel?.version ?? null,
        deployedModelTrainingSamples: deployedModel?.trainingSamples ?? null,
        newSinceLatestModel:
          latestModel?.trainingSamples == null
            ? trainerExpectedSamples
            : Math.max(0, trainerExpectedSamples - latestModel.trainingSamples),
        newSinceDeployedModel:
          deployedModel?.trainingSamples == null
            ? trainerExpectedSamples
            : Math.max(
                0,
                trainerExpectedSamples - deployedModel.trainingSamples,
              ),
        featureVersion: ML_FEATURE_VERSION,
        featureCount: ML_FEATURE_COUNT,
        lastTrainedAt: deployedModel?.createdAt ?? latestModel?.createdAt ?? null,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
