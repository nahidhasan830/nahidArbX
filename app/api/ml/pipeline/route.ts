/**
 * GET /api/ml/pipeline — comprehensive ML Optimizer pipeline stats.
 *
 * Single endpoint that returns the full picture: data collection health,
 * training readiness, inference status, feature-contract diagnostics,
 * rejected model reasons, score bucket ROI/CLV, and paper evaluation.
 * The UI polls this every 15 seconds.
 *
 * Query plan:
 *   Wave 1 — 12 independent SELECTs + 2 engine RPCs fire in one Promise.all.
 *   Wave 2 — 3 SELECTs that depend on the deployed model's policy edge
 *            threshold fire in a second Promise.all.
 *
 * Replaces a previously serial 14-query path that took ~Cloud-SQL-RTT × 14
 * per UI poll.
 */
import { NextResponse } from "next/server";
import { sql, and, eq, isNotNull, desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bets, mlModels, mlTrainingExamples } from "@/lib/db/schema";
import {
  ML_MIN_SCORE,
  ML_FEATURE_COUNT,
  ML_FEATURE_VERSION,
  ML_RETRAIN_GROWTH_STEP,
} from "@/lib/shared/constants";
import {
  FEATURE_NAMES_HASH,
  FEATURE_SQL_INDEX,
} from "@/lib/ml/feature-contract";
import {
  POLICY_EDGE_THRESHOLD_DENY_ALL_PCT,
  resolvePolicyEdgeThreshold,
} from "@/lib/ml/deployment-gate";
import { engineGet } from "@/lib/engine-proxy";
import { getCurrentCorpusAccounting } from "@/lib/ml/training-sample-accounting";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface DeploymentGateStatus {
  permissionLevel: string;
  policyEdgeThresholdPct: number;
  policyEdgeThresholdSource?: string;
  modelVersion: number | null;
  canGate: boolean;
  canReduceStake: boolean;
  canIncreaseStake: boolean;
  lastRefreshedAt: string | null;
}

interface ScorerStatus {
  modelLoaded: boolean;
  modelVersion: number | null;
  featureCount: number;
  vertexEndpoint: string | null;
  totalScored: number;
  totalScoringAttempts: number;
  avgInferenceMs: number;
  lastInferenceMs: number;
  error?: string;
}

interface SchedulerStatus {
  active: boolean;
  lastTickAt: number | null;
  totalRetrainTriggers: number;
  lastError: string | null;
  /** Absolute step (in training examples) that triggers an auto-retrain since the last deployed model. */
  retrainStep: number;
}

const PAPER_SIMPLE_RULE_MIN_EV_PCT = 3;
const PAPER_SIMPLE_RULE_MARKETS = ["ASIAN_HANDICAP", "MATCH_RESULT"] as const;
const TRAINING_EXAMPLE_COMPETITION_TIER_SQL_INDEX =
  FEATURE_SQL_INDEX.competition_tier;
const BET_COMPETITION_TIER_SQL_INDEX = FEATURE_SQL_INDEX.competition_tier;
const BET_ADJUSTED_ODDS_SQL_INDEX = FEATURE_SQL_INDEX.adjusted_soft_odds;
const BET_SOFT_ODDS_SQL_INDEX = FEATURE_SQL_INDEX.soft_odds;

function numOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundOrNull(value: unknown, digits = 2): number | null {
  const n = numOrNull(value);
  if (n == null) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function intOrZero(value: unknown): number {
  const n = numOrNull(value);
  return n == null ? 0 : Math.trunc(n);
}

export async function GET() {
  try {
    // ── Reusable SQL expressions ─────────────────────────────────────
    // Defined up front so wave 1 and wave 2 queries can share them.
    // Use unit returns instead of null pnl for unplaced bets.
    const unitReturnExpr = sql`
      CASE ${bets.outcome}
        WHEN 'won'       THEN (${bets.softOdds} - 1) * (1 - COALESCE(${bets.softCommissionPct}, 0) / 100)
        WHEN 'half_won'  THEN (${bets.softOdds} - 1) * (1 - COALESCE(${bets.softCommissionPct}, 0) / 100) * 0.5
        WHEN 'lost'      THEN -1.0
        WHEN 'half_lost' THEN -0.5
        ELSE 0
      END`;
    const evPctExpr = sql`
      (
        (
          ${bets.sharpTrueProb} *
          ((${bets.softOdds} - 1) * (1 - COALESCE(${bets.softCommissionPct}, 0) / 100))
        ) - (1 - ${bets.sharpTrueProb})
      ) * 100
    `;
    const mlModelEdgeExpr = sql`
      (
        ${bets.mlScore} *
        COALESCE(
          NULLIF((${bets.mlFeatures})[${BET_ADJUSTED_ODDS_SQL_INDEX}], 0),
          NULLIF((${bets.mlFeatures})[${BET_SOFT_ODDS_SQL_INDEX}], 0)
        )
        - 1
      ) * 100
    `;

    // ── Wave 1: 12 independent SELECTs + 2 engine RPCs in parallel ──
    const [
      accounting,
      [{ totalBets }],
      [{ betsWithFeatures }],
      [{ settledWithFeatures }],
      recentBets,
      featureVersionRows,
      featureLengthRows,
      semanticBetsResult,
      semanticTrainingResult,
      deployedPolicyRowSelect,
      allModels,
      inferenceResult,
      schedulerResult,
    ] = await Promise.all([
      getCurrentCorpusAccounting(db),
      db.select({ totalBets: sql<number>`count(*)::int` }).from(bets),
      db
        .select({ betsWithFeatures: sql<number>`count(*)::int` })
        .from(bets)
        .where(isNotNull(bets.mlFeatures)),
      db
        .select({ settledWithFeatures: sql<number>`count(*)::int` })
        .from(bets)
        .where(
          and(
            sql`${bets.outcome} NOT IN ('pending', 'void')`,
            isNotNull(bets.mlFeatures),
          ),
        ),
      // Recent feature extraction health: % of last 100 bets that have features
      db
        .select({
          hasFeatures: sql<boolean>`${bets.mlFeatures} IS NOT NULL`,
        })
        .from(bets)
        .orderBy(desc(bets.firstSeenAt))
        .limit(100),
      db
        .select({
          version: bets.mlFeatureVersion,
          cnt: sql<number>`count(*)::int`,
        })
        .from(bets)
        .where(isNotNull(bets.mlFeatures))
        .groupBy(bets.mlFeatureVersion),
      db
        .select({
          len: sql<number>`array_length(${bets.mlFeatures}, 1)`,
          cnt: sql<number>`count(*)::int`,
        })
        .from(bets)
        .where(isNotNull(bets.mlFeatures))
        .groupBy(sql`array_length(${bets.mlFeatures}, 1)`),
      db.execute(sql`
        SELECT
          count(*) FILTER (
            WHERE ${bets.mlFeatures} IS NOT NULL
              AND ${bets.mlFeatureVersion} = ${ML_FEATURE_VERSION}
              AND ${bets.mlFeatureNamesHash} = ${FEATURE_NAMES_HASH}
              AND array_length(${bets.mlFeatures}, 1) = ${ML_FEATURE_COUNT}
          )::int AS bets_with_current_features,
          count(*) FILTER (
            WHERE ${bets.mlFeatures} IS NOT NULL
              AND ${bets.mlFeatureVersion} = ${ML_FEATURE_VERSION}
              AND ${bets.mlFeatureNamesHash} = ${FEATURE_NAMES_HASH}
              AND array_length(${bets.mlFeatures}, 1) = ${ML_FEATURE_COUNT}
              AND COALESCE((${bets.mlFeatures})[${BET_COMPETITION_TIER_SQL_INDEX}], -1.0) NOT IN (1.0, 2.0, 3.0)
          )::int AS bad_competition_tier,
          count(*) FILTER (
            WHERE ${bets.outcome} NOT IN ('pending', 'void')
              AND ${bets.mlFeatures} IS NOT NULL
              AND ${bets.mlFeatureVersion} = ${ML_FEATURE_VERSION}
              AND ${bets.mlFeatureNamesHash} = ${FEATURE_NAMES_HASH}
              AND array_length(${bets.mlFeatures}, 1) = ${ML_FEATURE_COUNT}
          )::int AS trainable_settled_current_features,
          count(*) FILTER (
            WHERE ${bets.outcome} NOT IN ('pending', 'void')
              AND ${bets.mlFeatures} IS NOT NULL
              AND ${bets.mlFeatureVersion} = ${ML_FEATURE_VERSION}
              AND ${bets.mlFeatureNamesHash} = ${FEATURE_NAMES_HASH}
              AND array_length(${bets.mlFeatures}, 1) = ${ML_FEATURE_COUNT}
              AND COALESCE((${bets.mlFeatures})[${BET_COMPETITION_TIER_SQL_INDEX}], -1.0) NOT IN (1.0, 2.0, 3.0)
          )::int AS bad_trainable_competition_tier,
          count(*) FILTER (
            WHERE ${bets.firstSeenAt} >= now() - interval '24 hours'
              AND ${bets.mlFeatures} IS NOT NULL
              AND ${bets.mlFeatureVersion} = ${ML_FEATURE_VERSION}
              AND ${bets.mlFeatureNamesHash} = ${FEATURE_NAMES_HASH}
              AND array_length(${bets.mlFeatures}, 1) = ${ML_FEATURE_COUNT}
          )::int AS recent_24h_with_features,
          count(*) FILTER (
            WHERE ${bets.firstSeenAt} >= now() - interval '24 hours'
              AND ${bets.mlFeatures} IS NOT NULL
              AND ${bets.mlFeatureVersion} = ${ML_FEATURE_VERSION}
              AND ${bets.mlFeatureNamesHash} = ${FEATURE_NAMES_HASH}
              AND array_length(${bets.mlFeatures}, 1) = ${ML_FEATURE_COUNT}
              AND COALESCE((${bets.mlFeatures})[${BET_COMPETITION_TIER_SQL_INDEX}], -1.0) IN (1.0, 2.0, 3.0)
          )::int AS recent_24h_with_valid_tier
        FROM ${bets}
      `),
      db.execute(sql`
        SELECT
          count(*) FILTER (
            WHERE ${mlTrainingExamples.label} IS NOT NULL
              AND ${mlTrainingExamples.features} IS NOT NULL
              AND ${mlTrainingExamples.featureVersion} = ${ML_FEATURE_VERSION}
              AND array_length(${mlTrainingExamples.features}, 1) = ${ML_FEATURE_COUNT}
          )::int AS labeled_examples,
          count(*) FILTER (
            WHERE ${mlTrainingExamples.label} IS NOT NULL
              AND ${mlTrainingExamples.features} IS NOT NULL
              AND ${mlTrainingExamples.featureVersion} = ${ML_FEATURE_VERSION}
              AND array_length(${mlTrainingExamples.features}, 1) = ${ML_FEATURE_COUNT}
              AND COALESCE((${mlTrainingExamples.features})[${TRAINING_EXAMPLE_COMPETITION_TIER_SQL_INDEX}], -1.0) NOT IN (1.0, 2.0, 3.0)
          )::int AS bad_labeled_competition_tier
        FROM ${mlTrainingExamples}
      `),
      db
        .select({ trainingReport: mlModels.trainingReport })
        .from(mlModels)
        .where(eq(mlModels.status, "deployed"))
        .orderBy(desc(mlModels.deployedAt))
        .limit(1),
      db
        .select({
          id: mlModels.id,
          version: mlModels.version,
          status: mlModels.status,
          modelType: mlModels.modelType,
          trainingSamples: mlModels.trainingSamples,
          featureCount: mlModels.featureCount,
          featureVersion: mlModels.featureVersion,
          featureNamesHash: mlModels.featureNamesHash,
          trainingStartedAt: mlModels.trainingStartedAt,
          trainingCompletedAt: mlModels.trainingCompletedAt,
          trainingStage: mlModels.trainingStage,
          progressMessage: mlModels.progressMessage,
          lastHeartbeatAt: mlModels.lastHeartbeatAt,
          estimatedTimeRemainingMs: mlModels.estimatedTimeRemainingMs,
          oosRoiMean: mlModels.oosRoiMean,
          oosAccuracy: mlModels.oosAccuracy,
          oosAucRoc: mlModels.oosAucRoc,
          oosLogLoss: mlModels.oosLogLoss,
          deflatedSharpe: mlModels.deflatedSharpe,
          pbo: mlModels.pbo,
          calibrationError: mlModels.calibrationError,
          permissionLevel: mlModels.permissionLevel,
          rejectionReasons: mlModels.rejectionReasons,
          modelArtifactPath: mlModels.modelArtifactPath,
          vertexModelName: mlModels.vertexModelName,
          vertexEndpointName: mlModels.vertexEndpointName,
          deployedAt: mlModels.deployedAt,
          retiredAt: mlModels.retiredAt,
          notifiedAt: mlModels.notifiedAt,
          createdAt: mlModels.createdAt,
        })
        .from(mlModels)
        .where(
          sql`NOT (${mlModels.version} = 0 AND ${mlModels.status} = 'failed')`,
        )
        .orderBy(desc(mlModels.createdAt))
        .limit(50),
      engineGet<ScorerStatus & { deploymentGate?: DeploymentGateStatus }>(
        "/engine/ml/status",
      ),
      engineGet<SchedulerStatus>("/engine/ml/scheduler"),
    ]);

    // ── Recent feature extraction health ─────────────────────────────
    const recentWithFeatures = recentBets.filter((r) => r.hasFeatures).length;
    const recentFeatureRate =
      recentBets.length > 0
        ? Math.round((recentWithFeatures / recentBets.length) * 100)
        : 0;

    // ── Feature contract diagnostics ─────────────────────────────────
    const currentNamesHash = FEATURE_NAMES_HASH.slice(0, 16);
    const semanticBetsRow =
      (semanticBetsResult.rows[0] as Record<string, unknown> | undefined) ?? {};
    const semanticTrainingRow =
      (semanticTrainingResult.rows[0] as Record<string, unknown> | undefined) ??
      {};
    const badCompetitionTier = intOrZero(semanticBetsRow.bad_competition_tier);
    const badTrainableCompetitionTier = intOrZero(
      semanticBetsRow.bad_trainable_competition_tier,
    );
    const labeledExamples = intOrZero(semanticTrainingRow.labeled_examples);
    const badLabeledCompetitionTier = intOrZero(
      semanticTrainingRow.bad_labeled_competition_tier,
    );
    const recent24hWithFeatures = intOrZero(
      semanticBetsRow.recent_24h_with_features,
    );
    const recent24hWithValidTier = intOrZero(
      semanticBetsRow.recent_24h_with_valid_tier,
    );
    const recentTierValidPct =
      recent24hWithFeatures > 0
        ? Math.round((recent24hWithValidTier / recent24hWithFeatures) * 1000) /
          10
        : null;
    const semanticHealth = {
      betsWithCurrentFeatures: intOrZero(
        semanticBetsRow.bets_with_current_features,
      ),
      badCompetitionTier,
      trainableSettledCurrentFeatures: intOrZero(
        semanticBetsRow.trainable_settled_current_features,
      ),
      badTrainableCompetitionTier,
      labeledExamples,
      badLabeledCompetitionTier,
      cleanLabeledExamples: Math.max(
        0,
        labeledExamples - badLabeledCompetitionTier,
      ),
      badLabeledNonPositiveEv: 0,
      semanticPass:
        badCompetitionTier === 0 &&
        badTrainableCompetitionTier === 0 &&
        badLabeledCompetitionTier === 0,
    };
    const recentTierHealth = {
      windowHours: 24,
      betsWithFeatures: recent24hWithFeatures,
      betsWithValidTier: recent24hWithValidTier,
      // null when window is empty — distinguishes "no traffic" from "0%".
      validTierPct: recentTierValidPct,
      // Below this the enrichment cache is probably stuck.
      healthy: recent24hWithFeatures === 0 || recentTierValidPct! >= 80,
    };

    const featureContract = {
      currentVersion: ML_FEATURE_VERSION,
      currentFeatureCount: ML_FEATURE_COUNT,
      currentNamesHash,
      versionDistribution: featureVersionRows.map((r) => ({
        version: r.version ?? null,
        count: r.cnt,
      })),
      lengthDistribution: featureLengthRows.map((r) => ({
        length: r.len ?? null,
        count: r.cnt,
      })),
      allVersionsMatch:
        featureVersionRows.length === 1 &&
        featureVersionRows[0].version === ML_FEATURE_VERSION,
      allLengthsMatch:
        featureLengthRows.length === 1 &&
        featureLengthRows[0].len === ML_FEATURE_COUNT,
      semanticChecks: semanticHealth,
      allSemanticChecksPass: semanticHealth.semanticPass,
      recentTierHealth,
    };

    const totalAvailableSamples = accounting.trainerExpectedSamples;

    // ── Resolve deployed-model policy threshold (drives wave 2) ──────
    const deployedPolicyRow = deployedPolicyRowSelect[0];
    const deployedPolicyThreshold = deployedPolicyRow
      ? resolvePolicyEdgeThreshold(deployedPolicyRow.trainingReport)
      : {
          thresholdPct: POLICY_EDGE_THRESHOLD_DENY_ALL_PCT,
          source: "no_model" as const,
        };
    const mlPolicyThresholdPct = deployedPolicyThreshold.thresholdPct;

    // ── Wave 2: 3 SELECTs that depend on mlPolicyThresholdPct ────────
    const [bucketPerformance, paperMetricsResult, paperTrendResult] =
      await Promise.all([
        db.execute(sql`
          WITH scored AS (
            SELECT
              (${unitReturnExpr})::float AS unit_return,
              ${bets.clvPct}::float AS clv_pct,
              CASE WHEN ${bets.outcome} IN ('won', 'half_won') THEN 1.0 ELSE 0.0 END AS win,
              (${mlModelEdgeExpr})::float AS model_edge_pct
            FROM ${bets}
            WHERE ${bets.mlScore} IS NOT NULL
              AND ${bets.outcome} NOT IN ('pending', 'void')
              AND ${bets.mlFeatures} IS NOT NULL
              AND ${bets.mlFeatureVersion} = ${ML_FEATURE_VERSION}
              AND ${bets.mlFeatureNamesHash} = ${FEATURE_NAMES_HASH}
              AND array_length(${bets.mlFeatures}, 1) = ${ML_FEATURE_COUNT}
              AND (${bets.mlFeatures})[${BET_COMPETITION_TIER_SQL_INDEX}] IN (1.0, 2.0, 3.0)
          ),
          bucketed AS (
            SELECT
              CASE
                WHEN model_edge_pct <= 0 THEN 0
                WHEN model_edge_pct < 2 THEN 1
                WHEN model_edge_pct < 5 THEN 2
                WHEN model_edge_pct < 10 THEN 3
                WHEN model_edge_pct < 20 THEN 4
                ELSE 5
              END AS bucket_rank,
              CASE
                WHEN model_edge_pct <= 0 THEN '≤0%'
                WHEN model_edge_pct < 2 THEN '0–2%'
                WHEN model_edge_pct < 5 THEN '2–5%'
                WHEN model_edge_pct < 10 THEN '5–10%'
                WHEN model_edge_pct < 20 THEN '10–20%'
                ELSE '≥20%'
              END AS bucket,
              unit_return,
              clv_pct,
              win,
              model_edge_pct
            FROM scored
          )
          SELECT
            bucket_rank,
            bucket,
            count(*)::int AS cnt,
            coalesce(avg(unit_return) * 100, 0)::float AS avg_pnl,
            coalesce(avg(clv_pct), 0)::float AS avg_clv,
            coalesce(avg(win), 0)::float AS win_rate,
            coalesce(avg(model_edge_pct), 0)::float AS avg_edge
          FROM bucketed
          GROUP BY bucket_rank, bucket
          ORDER BY bucket_rank ASC
        `),
        db.execute(sql`
          WITH base AS (
            SELECT
              (${unitReturnExpr})::float AS unit_return,
              (${evPctExpr})::float AS ev_pct,
              ${bets.softOdds}::float AS soft_odds,
              ${bets.mlScore}::float AS ml_score,
              (${mlModelEdgeExpr})::float AS ml_model_edge_pct,
              ${bets.marketType} AS market_type,
              CASE WHEN ${bets.outcome} IN ('won', 'half_won') THEN 1.0 ELSE 0.0 END AS win
            FROM ${bets}
            WHERE ${bets.outcome} NOT IN ('pending', 'void')
              AND ${bets.mlFeatures} IS NOT NULL
              AND ${bets.mlFeatureVersion} = ${ML_FEATURE_VERSION}
              AND ${bets.mlFeatureNamesHash} = ${FEATURE_NAMES_HASH}
              AND array_length(${bets.mlFeatures}, 1) = ${ML_FEATURE_COUNT}
              AND (${bets.mlFeatures})[${BET_COMPETITION_TIER_SQL_INDEX}] IN (1.0, 2.0, 3.0)
          ),
          cohorts AS (
            SELECT 'detected_baseline' AS cohort, * FROM base
            UNION ALL
            SELECT 'simple_ev_core' AS cohort, * FROM base
            WHERE ev_pct >= ${PAPER_SIMPLE_RULE_MIN_EV_PCT}
              AND market_type IN (${sql.join(
                PAPER_SIMPLE_RULE_MARKETS.map((m) => sql`${m}`),
                sql`, `,
              )})
            UNION ALL
            SELECT 'ml_scored' AS cohort, * FROM base
            WHERE ml_score IS NOT NULL
            UNION ALL
            SELECT 'ml_gate' AS cohort, * FROM base
            WHERE ml_score IS NOT NULL
              AND ev_pct >= ${PAPER_SIMPLE_RULE_MIN_EV_PCT}
              AND market_type IN (${sql.join(
                PAPER_SIMPLE_RULE_MARKETS.map((m) => sql`${m}`),
                sql`, `,
              )})
              AND ml_model_edge_pct > ${mlPolicyThresholdPct}
          )
          SELECT
            cohort,
            count(*)::int AS sample_size,
            (avg(unit_return) * 100)::float AS roi_pct,
            (avg(win) * 100)::float AS win_rate_pct,
            avg(ev_pct)::float AS avg_ev_pct,
            avg(soft_odds)::float AS avg_odds
          FROM cohorts
          GROUP BY cohort
        `),
        db.execute(sql`
          WITH base AS (
            SELECT
              date_trunc('day', ${bets.firstSeenAt})::date AS day,
              (${unitReturnExpr})::float AS unit_return,
              (${evPctExpr})::float AS ev_pct,
              ${bets.mlScore}::float AS ml_score,
              (${mlModelEdgeExpr})::float AS ml_model_edge_pct,
              ${bets.marketType} AS market_type
            FROM ${bets}
            WHERE ${bets.outcome} NOT IN ('pending', 'void')
              AND ${bets.mlFeatures} IS NOT NULL
              AND ${bets.mlFeatureVersion} = ${ML_FEATURE_VERSION}
              AND ${bets.mlFeatureNamesHash} = ${FEATURE_NAMES_HASH}
              AND array_length(${bets.mlFeatures}, 1) = ${ML_FEATURE_COUNT}
              AND (${bets.mlFeatures})[${BET_COMPETITION_TIER_SQL_INDEX}] IN (1.0, 2.0, 3.0)
          )
          SELECT
            day::text,
            count(*)::int AS baseline_n,
            (avg(unit_return) * 100)::float AS baseline_roi_pct,
            count(*) FILTER (
              WHERE ev_pct >= ${PAPER_SIMPLE_RULE_MIN_EV_PCT}
                AND market_type IN (${sql.join(
                  PAPER_SIMPLE_RULE_MARKETS.map((m) => sql`${m}`),
                  sql`, `,
                )})
            )::int AS simple_n,
            (
              avg(unit_return) FILTER (
                WHERE ev_pct >= ${PAPER_SIMPLE_RULE_MIN_EV_PCT}
                  AND market_type IN (${sql.join(
                    PAPER_SIMPLE_RULE_MARKETS.map((m) => sql`${m}`),
                    sql`, `,
                  )})
              ) * 100
            )::float AS simple_roi_pct,
            count(*) FILTER (
              WHERE ml_score IS NOT NULL
                AND ev_pct >= ${PAPER_SIMPLE_RULE_MIN_EV_PCT}
                AND market_type IN (${sql.join(
                  PAPER_SIMPLE_RULE_MARKETS.map((m) => sql`${m}`),
                  sql`, `,
                )})
                AND ml_model_edge_pct > ${mlPolicyThresholdPct}
            )::int AS ml_gate_n,
            (
              avg(unit_return) FILTER (
                WHERE ml_score IS NOT NULL
                  AND ev_pct >= ${PAPER_SIMPLE_RULE_MIN_EV_PCT}
                  AND market_type IN (${sql.join(
                    PAPER_SIMPLE_RULE_MARKETS.map((m) => sql`${m}`),
                    sql`, `,
                  )})
                  AND ml_model_edge_pct > ${mlPolicyThresholdPct}
              ) * 100
            )::float AS ml_gate_roi_pct
          FROM base
          WHERE day >= current_date - interval '14 days'
          GROUP BY day
          ORDER BY day ASC
        `),
      ]);

    // ── Score-bucket ROI/CLV ─────────────────────────────────────────
    const bucketOrder = ["≤0%", "0–2%", "2–5%", "5–10%", "10–20%", "≥20%"];
    const bucketMap = Object.fromEntries(
      bucketPerformance.rows.map((row) => {
        const r = row as Record<string, unknown>;
        return [String(r.bucket), r];
      }),
    );
    const scoreBucketROI = bucketOrder.map((b) => ({
      bucket: b,
      count: intOrZero(bucketMap[b]?.cnt),
      avgPnl: roundOrNull(bucketMap[b]?.avg_pnl, 2) ?? 0,
      avgClv: Math.round((numOrNull(bucketMap[b]?.avg_clv) ?? 0) * 100) / 100,
      winRate: Math.round((numOrNull(bucketMap[b]?.win_rate) ?? 0) * 1000) / 10,
      avgEdge: roundOrNull(bucketMap[b]?.avg_edge, 2),
    }));

    // ── Paper-only evaluation ────────────────────────────────────────
    const metricLabels = {
      detected_baseline: "Detection Baseline",
      simple_ev_core: "Simple EV Rule",
      ml_scored: "Model Scored",
      ml_gate: "Model Gate",
    } as const;
    const emptyMetric = (key: keyof typeof metricLabels) => ({
      label: metricLabels[key],
      sampleSize: 0,
      roiPct: null as number | null,
      winRatePct: null as number | null,
      avgEvPct: null as number | null,
      avgOdds: null as number | null,
    });
    const paperMetricMap = Object.fromEntries(
      paperMetricsResult.rows.map((row) => {
        const r = row as Record<string, unknown>;
        const key = String(r.cohort);
        return [
          key,
          {
            label:
              metricLabels[key as keyof typeof metricLabels] ??
              key.replaceAll("_", " "),
            sampleSize: intOrZero(r.sample_size),
            roiPct: roundOrNull(r.roi_pct, 2),
            winRatePct: roundOrNull(r.win_rate_pct, 1),
            avgEvPct: roundOrNull(r.avg_ev_pct, 2),
            avgOdds: roundOrNull(r.avg_odds, 3),
          },
        ];
      }),
    ) as Partial<
      Record<keyof typeof metricLabels, ReturnType<typeof emptyMetric>>
    >;

    const detectedBaseline =
      paperMetricMap.detected_baseline ?? emptyMetric("detected_baseline");
    const simpleEvCore =
      paperMetricMap.simple_ev_core ?? emptyMetric("simple_ev_core");
    const mlScored = paperMetricMap.ml_scored ?? emptyMetric("ml_scored");
    const mlGate = paperMetricMap.ml_gate ?? emptyMetric("ml_gate");
    const simpleVsMlDelta =
      simpleEvCore.roiPct != null && mlGate.roiPct != null
        ? Math.round((mlGate.roiPct - simpleEvCore.roiPct) * 100) / 100
        : null;
    const paperEvaluation = {
      semanticHealth,
      simpleRule: {
        minEvPct: PAPER_SIMPLE_RULE_MIN_EV_PCT,
        marketTypes: [...PAPER_SIMPLE_RULE_MARKETS],
      },
      mlMinScore: ML_MIN_SCORE,
      mlModelEdgeThresholdPct: mlPolicyThresholdPct,
      mlModelEdgeThresholdSource: deployedPolicyThreshold.source,
      metrics: {
        detectedBaseline,
        simpleEvCore,
        mlScored,
        mlGate,
      },
      verdict: {
        enoughMlGateSamples: mlGate.sampleSize >= 100,
        mlBeatsSimpleRule: simpleVsMlDelta != null && simpleVsMlDelta > 0,
        mlMinusSimpleRoiPct: simpleVsMlDelta,
      },
      trend: paperTrendResult.rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          day: String(r.day ?? ""),
          baselineN: intOrZero(r.baseline_n),
          baselineRoiPct: roundOrNull(r.baseline_roi_pct, 2),
          simpleN: intOrZero(r.simple_n),
          simpleRoiPct: roundOrNull(r.simple_roi_pct, 2),
          mlGateN: intOrZero(r.ml_gate_n),
          mlGateRoiPct: roundOrNull(r.ml_gate_roi_pct, 2),
        };
      }),
    };

    // ── Training stats ───────────────────────────────────────────────
    const deployed = allModels.find((m) => m.status === "deployed") ?? null;
    const latest = allModels[0] ?? null;

    // Champion/challenger removed — the deployed model is the only "active"
    // model. Validated models stay as candidates; if a new one is validated,
    // the deployment gate retires the previous deployed model and deploys it.
    const trainingModels = allModels.filter((m) => m.status === "training");
    const modelsInTraining = trainingModels.length;

    // Active training model info — for real-time UI hydration on page load
    const activeTrainingModel = trainingModels[0] ?? null;
    const activeTraining = activeTrainingModel
      ? {
          modelId: activeTrainingModel.id,
          version: activeTrainingModel.version,
          status: activeTrainingModel.status,
          trainingStage: activeTrainingModel.trainingStage,
          progressMessage: activeTrainingModel.progressMessage,
          lastHeartbeatAt: activeTrainingModel.lastHeartbeatAt,
          estimatedRemainingMs: activeTrainingModel.estimatedTimeRemainingMs,
          sampleCount: activeTrainingModel.trainingSamples,
          startedAt: activeTrainingModel.trainingStartedAt,
          elapsedMs: activeTrainingModel.trainingStartedAt
            ? Date.now() -
              new Date(activeTrainingModel.trainingStartedAt).getTime()
            : null,
        }
      : null;

    const rejectedModels = allModels
      .filter(
        (m) =>
          m.status === "rejected" ||
          m.status === "failed" ||
          (m.rejectionReasons && (m.rejectionReasons as string[]).length > 0),
      )
      .slice(0, 5)
      .map((m) => ({
        version: m.version,
        status: m.status,
        reasons: (m.rejectionReasons as string[] | null) ?? [],
        createdAt: m.createdAt,
        trainingStartedAt: m.trainingStartedAt,
        trainingCompletedAt: m.trainingCompletedAt,
        trainingStage: m.trainingStage,
        progressMessage: m.progressMessage,
        lastHeartbeatAt: m.lastHeartbeatAt,
        trainingSamples: m.trainingSamples,
        oosAucRoc: m.oosAucRoc != null ? Number(m.oosAucRoc) : null,
        deflatedSharpe:
          m.deflatedSharpe != null ? Number(m.deflatedSharpe) : null,
        pbo: m.pbo != null ? Number(m.pbo) : null,
      }));

    // Retraining readiness — auto-retrain triggers after
    // ≥ML_RETRAIN_GROWTH_STEP new training examples since the last
    // deployed model. `examplesUntilRetrain` lets the UI render a
    // progress bar against the absolute step.
    let readyToRetrain = false;
    let newDataSinceLastTrain = 0;
    let examplesUntilRetrain = ML_RETRAIN_GROWTH_STEP;

    if (
      modelsInTraining === 0 &&
      totalAvailableSamples >= accounting.coldStartThreshold
    ) {
      if (!deployed) {
        readyToRetrain = true;
        newDataSinceLastTrain = totalAvailableSamples;
        examplesUntilRetrain = 0;
      } else {
        newDataSinceLastTrain = Math.max(
          0,
          totalAvailableSamples - deployed.trainingSamples,
        );
        examplesUntilRetrain = Math.max(
          0,
          ML_RETRAIN_GROWTH_STEP - newDataSinceLastTrain,
        );
        readyToRetrain = newDataSinceLastTrain >= ML_RETRAIN_GROWTH_STEP;
      }
    }

    // ── Inference status (engine proxy) ──────────────────────────────
    let inference: ScorerStatus = {
      modelLoaded: false,
      modelVersion: null,
      featureCount: 0,
      vertexEndpoint: deployed?.vertexEndpointName ?? null,
      totalScored: 0,
      totalScoringAttempts: 0,
      avgInferenceMs: 0,
      lastInferenceMs: 0,
    };
    let deploymentGate: DeploymentGateStatus | null = null;
    if (inferenceResult) {
      const { deploymentGate: gate, ...scorerFields } = inferenceResult;
      inference = {
        ...inference,
        ...scorerFields,
        vertexEndpoint:
          scorerFields.vertexEndpoint ?? deployed?.vertexEndpointName ?? null,
      };
      deploymentGate = gate ?? null;
    } else {
      inference.error = "Engine unreachable";
    }

    // ── Scheduler status (engine proxy) ──────────────────────────────
    let scheduler: SchedulerStatus = {
      active: false,
      lastTickAt: null,
      totalRetrainTriggers: 0,
      lastError: null,
      retrainStep: ML_RETRAIN_GROWTH_STEP,
    };
    if (schedulerResult) {
      scheduler = {
        ...schedulerResult,
        // Engine may run an older build without retrainStep — fall back
        // to the canonical constant so the UI can still display it.
        retrainStep: schedulerResult.retrainStep ?? ML_RETRAIN_GROWTH_STEP,
      };
    }

    // ── Resolve scoring mode label for UI ────────────────────────────
    const permLevel = deploymentGate?.permissionLevel ?? "observe";
    const scoringModeLabels: Record<string, string> = {
      observe: "Observe (log only)",
      gate_only: "Gate Only (positive model EV)",
      stake_reduce: "Stake Reduce (reduce weak bets)",
      stake_increase: "Stake Adjust (full ML sizing)",
    };
    const scoringMode = inference.modelLoaded
      ? (scoringModeLabels[permLevel] ?? "Unknown")
      : "Pass-through (no model)";

    return NextResponse.json({
      dataCollection: {
        totalBets,
        betsWithFeatures,
        settledWithFeatures,
        qualifiedForTraining: totalAvailableSamples,
        canonicalExamples: accounting.canonicalExamples,
        uncoveredQualifiedBets: accounting.uncoveredQualifiedBets,
        coldStartThreshold: accounting.coldStartThreshold,
        coldStartProgress: Math.min(
          100,
          Math.round(
            (totalAvailableSamples / accounting.coldStartThreshold) * 100,
          ),
        ),
        featureExtractionHealthy: recentFeatureRate > 50,
        recentFeatureRate,
        currentCorpus: {
          totalSettled: accounting.totalSettled,
          currentContractFeatures: accounting.currentContractFeatures,
          wins: accounting.wins,
          losses: accounting.losses,
          coldStartThreshold: accounting.coldStartThreshold,
          collectionTarget: accounting.collectionTarget,
          remainingToColdStart: accounting.remainingToColdStart,
          remainingToTarget: accounting.remainingToTarget,
          dailyTrend: accounting.dailyHistory,
        },
      },
      training: {
        totalModels: allModels.length,
        deployedModel: deployed,
        latestModel: latest,
        modelsInTraining,
        readyToRetrain,
        newDataSinceLastTrain,
        examplesUntilRetrain,
        retrainStep: ML_RETRAIN_GROWTH_STEP,
        activeTraining,
      },
      inference,
      scheduler,
      deploymentGate: deploymentGate ?? {
        permissionLevel: "observe",
        policyEdgeThresholdPct: 0,
        policyEdgeThresholdSource: "no_model",
        modelVersion: null,
        canGate: false,
        canReduceStake: false,
        canIncreaseStake: false,
        lastRefreshedAt: null,
      },
      scoringMode,
      featureContract,
      scoreBucketROI,
      paperEvaluation,
      rejectedModels,
      // Model version history for comparison table
      modelHistory: allModels
        .filter((m) => m.version > 0 && m.status !== "training")
        .slice(0, 10)
        .map((m) => ({
          version: m.version,
          status: m.status,
          trainingSamples: m.trainingSamples,
          featureCount: m.featureCount,
          featureVersion: m.featureVersion,
          featureNamesHash: m.featureNamesHash,
          modelArtifactPath: m.modelArtifactPath,
          vertexModelName: m.vertexModelName,
          vertexEndpointName: m.vertexEndpointName,
          oosAucRoc: m.oosAucRoc != null ? Number(m.oosAucRoc) : null,
          deflatedSharpe:
            m.deflatedSharpe != null ? Number(m.deflatedSharpe) : null,
          pbo: m.pbo != null ? Number(m.pbo) : null,
          permissionLevel: m.permissionLevel,
          rejectionReasons: (m.rejectionReasons as string[] | null) ?? null,
          deployedAt: m.deployedAt,
          createdAt: m.createdAt,
        })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
