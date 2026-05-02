/**
 * GET /api/ml/pipeline — comprehensive Bet Optimizer pipeline stats.
 *
 * Single endpoint that returns the full picture: data collection health,
 * training readiness, inference status, and score distribution.
 * The UI polls this every 15 seconds.
 */
import { NextResponse } from "next/server";
import { sql, and, isNotNull, desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { bets, mlModels } from "@/lib/db/schema";
import { ML_COLD_START_THRESHOLD, ML_MIN_SCORE } from "@/lib/shared/constants";
import { engineGet } from "@/lib/engine-proxy";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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

    // ── Training stats ──────────────────────────────────────────────
    const allModels = await db
      .select()
      .from(mlModels)
      .orderBy(desc(mlModels.createdAt))
      .limit(50);

    const deployed = allModels.find((m) => m.status === "deployed") ?? null;
    const latest = allModels[0] ?? null;
    const modelsInTraining = allModels.filter(
      (m) => m.status === "training",
    ).length;

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
    const inferenceResult = await engineGet<ScorerStatus>("/engine/ml/status");
    if (inferenceResult) {
      inference = inferenceResult;
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
      },
      inference,
      scheduler,
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

    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
