/**
 * GET /api/ml/pipeline — comprehensive ML Optimizer pipeline stats.
 *
 * Single endpoint that returns the full picture: data collection health,
 * training readiness, inference status, feature-contract diagnostics,
 * rejected model reasons, score bucket ROI/CLV, and paper evaluation.
 * The UI polls this every 15 seconds.
 */
import { NextResponse } from "next/server";
import { sql, and, eq, isNotNull, desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bets, mlModels, mlTrainingExamples } from "@/lib/db/schema";
import {
  ML_COLD_START_THRESHOLD,
  ML_MIN_SCORE,
  ML_FEATURE_COUNT,
  ML_FEATURE_VERSION,
  ML_RETRAIN_GROWTH_STEP,
} from "@/lib/shared/constants";
import { FEATURE_NAMES_HASH } from "@/lib/ml/feature-contract";
import {
  POLICY_EDGE_THRESHOLD_DENY_ALL_PCT,
  resolvePolicyEdgeThreshold,
} from "@/lib/ml/deployment-gate";
import { engineGet } from "@/lib/engine-proxy";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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
  modelPath: string | null;
  featureCount: number;
  totalScored: number;
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
    // ── Data collection stats ───────────────────────────────────────
    const [[{ totalBets }], [{ betsWithFeatures }], [{ settledWithFeatures }]] =
      await Promise.all([
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
      ]);

    // Recent feature extraction health: % of last 100 bets that have features
    const recentBets = await db
      .select({
        hasFeatures: sql<boolean>`${bets.mlFeatures} IS NOT NULL`,
      })
      .from(bets)
      .orderBy(desc(bets.firstSeenAt))
      .limit(100);

    const recentWithFeatures = recentBets.filter((r) => r.hasFeatures).length;
    const recentFeatureRate =
      recentBets.length > 0
        ? Math.round((recentWithFeatures / recentBets.length) * 100)
        : 0;

    // ── Feature contract diagnostics (Phase 10) ─────────────────────
    const featureVersionRows = await db
      .select({
        version: bets.mlFeatureVersion,
        cnt: sql<number>`count(*)::int`,
      })
      .from(bets)
      .where(isNotNull(bets.mlFeatures))
      .groupBy(bets.mlFeatureVersion);

    const featureLengthRows = await db
      .select({
        len: sql<number>`array_length(${bets.mlFeatures}, 1)`,
        cnt: sql<number>`count(*)::int`,
      })
      .from(bets)
      .where(isNotNull(bets.mlFeatures))
      .groupBy(sql`array_length(${bets.mlFeatures}, 1)`);

    const currentNamesHash = FEATURE_NAMES_HASH.slice(0, 16);

    const semanticBetsResult = await db.execute(sql`
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
            AND COALESCE((${bets.mlFeatures})[22], -1.0) NOT IN (1.0, 2.0, 3.0)
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
            AND COALESCE((${bets.mlFeatures})[22], -1.0) NOT IN (1.0, 2.0, 3.0)
        )::int AS bad_trainable_competition_tier
      FROM ${bets}
    `);
    const semanticTrainingResult = await db.execute(sql`
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
            AND COALESCE((${mlTrainingExamples.features})[22], -1.0) NOT IN (1.0, 2.0, 3.0)
        )::int AS bad_labeled_competition_tier
      FROM ${mlTrainingExamples}
    `);
    const semanticBetsRow =
      (semanticBetsResult.rows[0] as Record<string, unknown> | undefined) ??
      {};
    const semanticTrainingRow =
      (semanticTrainingResult.rows[0] as Record<string, unknown> | undefined) ??
      {};
    const badCompetitionTier = intOrZero(
      semanticBetsRow.bad_competition_tier,
    );
    const badTrainableCompetitionTier = intOrZero(
      semanticBetsRow.bad_trainable_competition_tier,
    );
    const labeledExamples = intOrZero(semanticTrainingRow.labeled_examples);
    const badLabeledCompetitionTier = intOrZero(
      semanticTrainingRow.bad_labeled_competition_tier,
    );
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
      cleanLabeledExamples: Math.max(0, labeledExamples - badLabeledCompetitionTier),
      badLabeledNonPositiveEv: 0,
      semanticPass:
        badCompetitionTier === 0 &&
        badTrainableCompetitionTier === 0 &&
        badLabeledCompetitionTier === 0,
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
    };

    // Phase 2: Canonical examples — this mirrors the Python loader's
    // precedence, feature-length filtering, and semantic feature guard.
    const canonicalExampleRows = await getCanonicalTrainingExampleRows();
    const examplesCount = canonicalExampleRows.length;

    // Phase 2: Coverage check — only labeled, current-version examples
    // count as "covered". Unlabeled or stale-version rows don't prevent
    // the fallback bets path from supplementing.
    const trainedIds = new Set(
      canonicalExampleRows
        .map((r) => r.sourceBetId)
        .filter((id): id is string => id != null),
    );

    const qualifiedRows = await db
      .select({ id: bets.id })
      .from(bets)
      .where(
        and(
          sql`${bets.outcome} NOT IN ('pending', 'void')`,
          isNotNull(bets.mlFeatures),
          sql`${bets.mlFeatureVersion} = ${ML_FEATURE_VERSION}`,
          sql`${bets.mlFeatureNamesHash} = ${FEATURE_NAMES_HASH}`,
          sql`array_length(${bets.mlFeatures}, 1) = ${ML_FEATURE_COUNT}`,
          sql`(${bets.mlFeatures})[22] IN (1.0, 2.0, 3.0)`,
        ),
      );

    const uncoveredCount =
      examplesCount > 0
        ? 0
        : qualifiedRows.filter((r) => !trainedIds.has(r.id)).length;
    const totalAvailableSamples =
      examplesCount > 0 ? examplesCount : uncoveredCount;

    // ── Score bucket ROI/CLV (Phase 10 + Phase 2) ────────────────────
    // Phase 2: Use unit returns instead of null pnl for unplaced bets.
    // Commission-adjusted net return: (odds-1)*(1-commission/100)
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
        COALESCE(NULLIF((${bets.mlFeatures})[4], 0), NULLIF((${bets.mlFeatures})[3], 0))
        - 1
      ) * 100
    `;
    const [deployedPolicyRow] = await db
      .select({ trainingReport: mlModels.trainingReport })
      .from(mlModels)
      .where(eq(mlModels.status, "deployed"))
      .orderBy(desc(mlModels.deployedAt))
      .limit(1);
    const deployedPolicyThreshold = deployedPolicyRow
      ? resolvePolicyEdgeThreshold(deployedPolicyRow.trainingReport)
      : {
          thresholdPct: POLICY_EDGE_THRESHOLD_DENY_ALL_PCT,
          source: "no_model" as const,
        };
    const mlPolicyThresholdPct = deployedPolicyThreshold.thresholdPct;

    const bucketPerformance = await db.execute(sql`
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
          AND (${bets.mlFeatures})[22] IN (1.0, 2.0, 3.0)
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
    `);

    // Ensure all 6 model-edge buckets are present in order.
    const bucketOrder = [
      "≤0%",
      "0–2%",
      "2–5%",
      "5–10%",
      "10–20%",
      "≥20%",
    ];
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

    // ── Paper-only evaluation ───────────────────────────────────────
    // This is the operator-facing target: compare ML against simple rules on
    // settled, semantically clean, detected opportunities before real money.
    const paperMetricsResult = await db.execute(sql`
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
          AND (${bets.mlFeatures})[22] IN (1.0, 2.0, 3.0)
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
    `);
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
      Record<
        keyof typeof metricLabels,
        ReturnType<typeof emptyMetric>
      >
    >;

    const paperTrendResult = await db.execute(sql`
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
          AND (${bets.mlFeatures})[22] IN (1.0, 2.0, 3.0)
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
    `);

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

    // ── Training stats ──────────────────────────────────────────────
    const allModels = await db
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
      .limit(50);

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

    // Rejected models (Phase 10)
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
      totalAvailableSamples >= ML_COLD_START_THRESHOLD
    ) {
      if (!deployed) {
        // No deployed model yet — first training is queued the moment
        // cold-start passes. Treat this as "ready" with full bar.
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
      modelPath: null,
      featureCount: 0,
      totalScored: 0,
      avgInferenceMs: 0,
      lastInferenceMs: 0,
    };
    let deploymentGate: DeploymentGateStatus | null = null;
    const inferenceResult = await engineGet<
      ScorerStatus & { deploymentGate?: DeploymentGateStatus }
    >("/engine/ml/status");
    if (inferenceResult) {
      const { deploymentGate: gate, ...scorerFields } = inferenceResult;
      inference = scorerFields;
      deploymentGate = gate ?? null;
    } else {
      inference.error = "Engine unreachable";
    }

    // ── Scheduler status (engine proxy) ─────────────────────────────
    let scheduler: SchedulerStatus = {
      active: false,
      lastTickAt: null,
      totalRetrainTriggers: 0,
      lastError: null,
      retrainStep: ML_RETRAIN_GROWTH_STEP,
    };
    const schedulerResult = await engineGet<SchedulerStatus>(
      "/engine/ml/scheduler",
    );
    if (schedulerResult) {
      scheduler = {
        ...schedulerResult,
        // Engine may run an older build without retrainStep — fall back
        // to the canonical constant so the UI can still display it.
        retrainStep: schedulerResult.retrainStep ?? ML_RETRAIN_GROWTH_STEP,
      };
    }

    // ── Resolve scoring mode label for UI ──────────────────────────────
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
        coldStartThreshold: ML_COLD_START_THRESHOLD,
        coldStartProgress: Math.min(
          100,
          Math.round((totalAvailableSamples / ML_COLD_START_THRESHOLD) * 100),
        ),
        featureExtractionHealthy: recentFeatureRate > 50,
        recentFeatureRate,
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
