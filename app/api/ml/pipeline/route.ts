/**
 * GET /api/ml/pipeline — comprehensive ML Optimizer pipeline stats.
 *
 * Single endpoint that returns the full picture: data collection health,
 * training readiness, inference status, score distribution, and Phase 10
 * diagnostic data (feature contract, enrichment coverage, training
 * sample composition, rejected model reasons, score bucket ROI/CLV).
 * The UI polls this every 15 seconds.
 */
import { NextResponse } from "next/server";
import { sql, and, isNotNull, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bets, mlModels, competitionEnrichments, mlTrainingExamples, mlSchedulerSettings } from "@/lib/db/schema";
import { ML_COLD_START_THRESHOLD, ML_MIN_SCORE, ML_FEATURE_COUNT, ML_FEATURE_VERSION } from "@/lib/shared/constants";
import { FEATURE_NAMES_HASH } from "@/lib/ml/features";
import { engineGet } from "@/lib/engine-proxy";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function getSchedulerSettings() {
  try {
    const [row] = await db
      .select()
      .from(mlSchedulerSettings)
      .where(eq(mlSchedulerSettings.id, "default"))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

interface DeploymentGateStatus {
  permissionLevel: string;
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
    };

    // ── Enrichment cache coverage (Phase 10) ────────────────────────
    const distinctComps = await db
      .select({ cnt: sql<number>`count(DISTINCT competition)::int` })
      .from(bets)
      .where(isNotNull(bets.competition));

    const enrichedComps = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(competitionEnrichments);

    const highConfidenceEnrichments = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(competitionEnrichments)
      .where(sql`${competitionEnrichments.confidence} >= 70`);

    const enrichmentCoverage = {
      distinctCompetitions: distinctComps[0]?.cnt ?? 0,
      enrichedCompetitions: enrichedComps[0]?.cnt ?? 0,
      highConfidence: highConfidenceEnrichments[0]?.cnt ?? 0,
      coveragePct:
        (distinctComps[0]?.cnt ?? 0) > 0
          ? Math.round(
              ((enrichedComps[0]?.cnt ?? 0) /
                (distinctComps[0]?.cnt ?? 0)) *
                100,
            )
          : 0,
    };

    // ── Training sample composition (Phase 10) ──────────────────────
    const exampleTypeCounts = await db
      .select({
        exampleType: mlTrainingExamples.exampleType,
        cnt: sql<number>`count(*)::int`,
      })
      .from(mlTrainingExamples)
      .groupBy(mlTrainingExamples.exampleType);

    const labelCounts = await db
      .select({
        label: mlTrainingExamples.label,
        cnt: sql<number>`count(*)::int`,
      })
      .from(mlTrainingExamples)
      .where(isNotNull(mlTrainingExamples.label))
      .groupBy(mlTrainingExamples.label);

    const trainingComposition = {
      byType: Object.fromEntries(
        exampleTypeCounts.map((r) => [r.exampleType, r.cnt]),
      ),
      byLabel: Object.fromEntries(
        labelCounts.map((r) => [r.label ?? "unlabeled", r.cnt]),
      ),
      totalExamples: exampleTypeCounts.reduce((s, r) => s + r.cnt, 0),
    };

    // ── Score bucket ROI/CLV (Phase 10) ─────────────────────────────
    // Query settled bets that have both ml_score and pnl/clv_pct
    const bucketPerformance = await db
      .select({
        bucket: sql<string>`
          CASE
            WHEN ${bets.mlScore} < 0.4 THEN '<0.4'
            WHEN ${bets.mlScore} < 0.5 THEN '0.4–0.5'
            WHEN ${bets.mlScore} < 0.6 THEN '0.5–0.6'
            WHEN ${bets.mlScore} < 0.7 THEN '0.6–0.7'
            WHEN ${bets.mlScore} < 0.8 THEN '0.7–0.8'
            ELSE '≥0.8'
          END`,
        cnt: sql<number>`count(*)::int`,
        avgPnl: sql<number>`coalesce(avg(${bets.pnl}::float), 0)::float`,
        avgClv: sql<number>`coalesce(avg(${bets.clvPct}::float), 0)::float`,
        winRate: sql<number>`coalesce(
          avg(CASE WHEN ${bets.outcome} IN ('won', 'half_won') THEN 1.0 ELSE 0.0 END),
          0
        )::float`,
      })
      .from(bets)
      .where(
        and(
          isNotNull(bets.mlScore),
          sql`${bets.outcome} NOT IN ('pending', 'void')`,
        ),
      )
      .groupBy(sql`
        CASE
          WHEN ${bets.mlScore} < 0.4 THEN '<0.4'
          WHEN ${bets.mlScore} < 0.5 THEN '0.4–0.5'
          WHEN ${bets.mlScore} < 0.6 THEN '0.5–0.6'
          WHEN ${bets.mlScore} < 0.7 THEN '0.6–0.7'
          WHEN ${bets.mlScore} < 0.8 THEN '0.7–0.8'
          ELSE '≥0.8'
        END`);

    // Ensure all 6 buckets are present in order
    const bucketOrder = ["<0.4", "0.4–0.5", "0.5–0.6", "0.6–0.7", "0.7–0.8", "≥0.8"];
    const bucketMap = Object.fromEntries(
      bucketPerformance.map((r) => [r.bucket, r]),
    );
    const scoreBucketROI = bucketOrder.map((b) => ({
      bucket: b,
      count: bucketMap[b]?.cnt ?? 0,
      avgPnl: Math.round((bucketMap[b]?.avgPnl ?? 0) * 100) / 100,
      avgClv: Math.round((bucketMap[b]?.avgClv ?? 0) * 100) / 100,
      winRate: Math.round((bucketMap[b]?.winRate ?? 0) * 1000) / 10,
    }));

    // ── Training stats ──────────────────────────────────────────────
    const allModels = await db
      .select()
      .from(mlModels)
      .orderBy(desc(mlModels.createdAt))
      .limit(50);

    const deployed = allModels.find((m) => m.status === "deployed") ?? null;
    const latest = allModels[0] ?? null;
    const trainingModels = allModels.filter(
      (m) => m.status === "training",
    );
    const modelsInTraining = trainingModels.length;

    // Active training model info — for real-time UI hydration on page load
    const activeTrainingModel = trainingModels[0] ?? null;
    const activeTraining = activeTrainingModel
      ? {
          modelId: activeTrainingModel.id,
          version: activeTrainingModel.version,
          status: activeTrainingModel.status,
          startedAt: activeTrainingModel.trainingStartedAt,
          elapsedMs: activeTrainingModel.trainingStartedAt
            ? Date.now() - new Date(activeTrainingModel.trainingStartedAt).getTime()
            : null,
        }
      : null;

    // Rejected models (Phase 10)
    const rejectedModels = allModels
      .filter((m) => m.status === "rejected" || (m.rejectionReasons && (m.rejectionReasons as string[]).length > 0))
      .slice(0, 5)
      .map((m) => ({
        version: m.version,
        status: m.status,
        reasons: (m.rejectionReasons as string[] | null) ?? [],
        createdAt: m.createdAt,
        trainingSamples: m.trainingSamples,
        oosAucRoc: m.oosAucRoc != null ? Number(m.oosAucRoc) : null,
        deflatedSharpe: m.deflatedSharpe != null ? Number(m.deflatedSharpe) : null,
        pbo: m.pbo != null ? Number(m.pbo) : null,
      }));

    // Retraining readiness (mirrors scheduler.ts shouldRetrain logic)
    let readyToRetrain = false;
    let newDataSinceLastTrain = 0;
    let growthPct = 0;

    if (modelsInTraining === 0 && settledWithFeatures >= ML_COLD_START_THRESHOLD) {
      if (!deployed) {
        readyToRetrain = true;
        newDataSinceLastTrain = settledWithFeatures;
        growthPct = 100;
      } else {
        newDataSinceLastTrain = settledWithFeatures - deployed.trainingSamples;
        growthPct =
          deployed.trainingSamples > 0
            ? Math.round(
                (newDataSinceLastTrain / deployed.trainingSamples) * 100,
              )
            : 100;
        readyToRetrain = newDataSinceLastTrain > deployed.trainingSamples * 0.2;
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
    const inferenceResult = await engineGet<ScorerStatus & { deploymentGate?: DeploymentGateStatus }>("/engine/ml/status");
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
    };
    const schedulerResult = await engineGet<SchedulerStatus>("/engine/ml/scheduler");
    if (schedulerResult) {
      scheduler = schedulerResult;
    }

    // ── Score distribution (last 200 scored bets) ───────────────────
    const scoredBets = await db
      .select({ mlScore: bets.mlScore })
      .from(bets)
      .where(isNotNull(bets.mlScore))
      .orderBy(desc(bets.firstSeenAt))
      .limit(200);

    const bucketLabels = [
      "0.0–0.1", "0.1–0.2", "0.2–0.3", "0.3–0.4", "0.4–0.5",
      "0.5–0.6", "0.6–0.7", "0.7–0.8", "0.8–0.9", "0.9–1.0",
    ];
    const bucketCounts = new Array(10).fill(0) as number[];
    let scoreSum = 0;
    let belowThreshold = 0;

    for (const row of scoredBets) {
      const s = row.mlScore ?? 0;
      scoreSum += s;
      const idx = Math.min(Math.floor(s * 10), 9);
      bucketCounts[idx]++;
      if (s < ML_MIN_SCORE) belowThreshold++;
    }



    // ── Resolve scoring mode label for UI ──────────────────────────────
    const permLevel = deploymentGate?.permissionLevel ?? "shadow";
    const scoringModeLabels: Record<string, string> = {
      shadow: "Shadow (log only)",
      gate_only: "Gate Only (skip low scores)",
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
        coldStartThreshold: ML_COLD_START_THRESHOLD,
        coldStartProgress: Math.min(
          100,
          Math.round((settledWithFeatures / ML_COLD_START_THRESHOLD) * 100),
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
        growthPct,
        activeTraining,
      },
      inference,
      scheduler,
      deploymentGate: deploymentGate ?? {
        permissionLevel: "shadow",
        modelVersion: null,
        canGate: false,
        canReduceStake: false,
        canIncreaseStake: false,
        lastRefreshedAt: null,
      },
      scoringMode,
      scoreDistribution: {
        buckets: bucketLabels.map((range, i) => ({
          range,
          count: bucketCounts[i],
        })),
        avgScore:
          scoredBets.length > 0
            ? Math.round((scoreSum / scoredBets.length) * 1000) / 1000
            : 0,
        belowThreshold,
        aboveThreshold: scoredBets.length - belowThreshold,
        totalScored: scoredBets.length,
      },
      // Phase 10 diagnostic data
      featureContract,
      enrichmentCoverage,
      trainingComposition,
      scoreBucketROI,
      rejectedModels,
      // Scheduler settings from DB
      schedulerSettings: await getSchedulerSettings(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
