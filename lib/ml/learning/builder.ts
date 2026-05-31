import crypto from "node:crypto";
import { desc, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  mlLearningSnapshots,
  mlModels,
  mlPredictionAudit,
  mlTrainingExamples,
} from "@/lib/db/schema";
import { ML_FEATURE_COUNT, ML_FEATURE_VERSION } from "@/lib/shared/constants";
import {
  FEATURE_NAMES_HASH,
  FEATURE_SQL_INDEX,
} from "@/lib/ml/feature-contract";
import {
  POLICY_EDGE_THRESHOLD_DENY_ALL_PCT,
  resolvePolicyEdgeThreshold,
} from "@/lib/ml/deployment-gate";
import type {
  LearningCalibrationBucket,
  LearningFeatureImportance,
  LearningMetric,
  LearningModelHistoryRow,
  LearningScoreBucket,
  LearningSnapshotMetrics,
  LearningSnapshotResponse,
  LearningVerdict,
} from "./types";

type DbLike = typeof db;

type PredictionRow = {
  id: number;
  scoredAt: string;
  modelVersion: number | null;
  mlScore: number;
  modelEdgePct: number | null;
  baselineEvPct: number | null;
  softOdds: number;
  softCommissionPct: number;
  marketType: string;
  outcome: string;
  pnl: number | null;
  clvPct: number | null;
  settledAt: string | null;
  placed: boolean;
};

const SIMPLE_RULE_MIN_EV_PCT = 3;
const SIMPLE_RULE_MARKETS = new Set(["ASIAN_HANDICAP", "MATCH_RESULT"]);
const MIN_SETTLED_FOR_VERDICT = 100;
const MIN_GATE_FOR_VERDICT = 50;
const CALIBRATION_WARN_ECE = 0.08;
const SETTLEMENT_LAG_WARN_PCT = 60;

function numOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value: number | null | undefined, digits = 4): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isSettled(outcome: string): boolean {
  return outcome !== "pending" && outcome !== "void";
}

function labelValue(outcome: string): number {
  if (outcome === "won") return 1;
  if (outcome === "half_won") return 0.5;
  if (outcome === "half_lost") return 0;
  return 0;
}

function unitReturn(row: PredictionRow): number {
  if (row.outcome === "won") {
    return (row.softOdds - 1) * (1 - row.softCommissionPct / 100);
  }
  if (row.outcome === "half_won") {
    return (row.softOdds - 1) * (1 - row.softCommissionPct / 100) * 0.5;
  }
  if (row.outcome === "lost") return -1;
  if (row.outcome === "half_lost") return -0.5;
  return 0;
}

function isSimpleRule(row: PredictionRow): boolean {
  return (
    (row.baselineEvPct ?? Number.NEGATIVE_INFINITY) >= SIMPLE_RULE_MIN_EV_PCT &&
    SIMPLE_RULE_MARKETS.has(row.marketType)
  );
}

function isMlGate(row: PredictionRow, thresholdPct: number): boolean {
  return (
    row.mlScore != null &&
    isSimpleRule(row) &&
    (row.modelEdgePct ?? Number.NEGATIVE_INFINITY) > thresholdPct
  );
}

function average(values: number[]): number | null {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function buildMetric(label: string, rows: PredictionRow[]): LearningMetric {
  const settled = rows.filter((row) => isSettled(row.outcome));
  const returns = settled.map(unitReturn);
  const wins = settled.map((row) => labelValue(row.outcome));
  return {
    label,
    sampleSize: settled.length,
    roiPct: round((average(returns) ?? 0) * 100, 4),
    winRatePct:
      settled.length > 0
        ? round(
            (wins.reduce((sum, value) => sum + value, 0) / settled.length) *
              100,
            4,
          )
        : null,
    avgEvPct: round(average(settled.map((row) => row.baselineEvPct ?? NaN)), 4),
    avgModelEdgePct: round(
      average(settled.map((row) => row.modelEdgePct ?? NaN)),
      4,
    ),
    avgClvPct: round(average(settled.map((row) => row.clvPct ?? NaN)), 4),
  };
}

function aucRoc(labels: number[], scores: number[]): number | null {
  const pairs = labels
    .map((label, index) => ({ label, score: scores[index] }))
    .filter((p) => Number.isFinite(p.label) && Number.isFinite(p.score));
  const pos = pairs.filter((p) => p.label > 0).length;
  const neg = pairs.length - pos;
  if (pos === 0 || neg === 0) return null;

  const sorted = [...pairs].sort((a, b) => a.score - b.score);
  let rankSum = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].score === sorted[i].score) j += 1;
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k += 1) {
      if (sorted[k].label > 0) rankSum += avgRank;
    }
    i = j;
  }
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

function buildCalibration(rows: PredictionRow[]): {
  buckets: LearningCalibrationBucket[];
  ece: number | null;
  brier: number | null;
  logLoss: number | null;
  auc: number | null;
} {
  const settled = rows.filter((row) => isSettled(row.outcome));
  if (settled.length === 0) {
    return { buckets: [], ece: null, brier: null, logLoss: null, auc: null };
  }
  const labels = settled.map((row) => labelValue(row.outcome));
  const scores = settled.map((row) =>
    Math.min(1 - 1e-7, Math.max(1e-7, row.mlScore)),
  );
  const brier =
    scores.reduce(
      (sum, score, index) => sum + (score - labels[index]) ** 2,
      0,
    ) / scores.length;
  const logLoss =
    scores.reduce((sum, score, index) => {
      const y = labels[index];
      return sum - (y * Math.log(score) + (1 - y) * Math.log(1 - score));
    }, 0) / scores.length;

  const buckets: LearningCalibrationBucket[] = [];
  let ece = 0;
  for (let i = 0; i < 10; i += 1) {
    const low = i / 10;
    const high = (i + 1) / 10;
    const bucketRows = settled.filter((row) =>
      i === 9
        ? row.mlScore >= low && row.mlScore <= high
        : row.mlScore >= low && row.mlScore < high,
    );
    const predicted = average(bucketRows.map((row) => row.mlScore));
    const actual = average(bucketRows.map((row) => labelValue(row.outcome)));
    if (predicted != null && actual != null && settled.length > 0) {
      ece +=
        (bucketRows.length / settled.length) * Math.abs(predicted - actual);
    }
    buckets.push({
      bucket: `${Math.round(low * 100)}-${Math.round(high * 100)}%`,
      low,
      high,
      count: bucketRows.length,
      predictedPct: round(predicted == null ? null : predicted * 100, 2),
      actualPct: round(actual == null ? null : actual * 100, 2),
      gapPct:
        predicted == null || actual == null
          ? null
          : round((actual - predicted) * 100, 2),
    });
  }

  return {
    buckets,
    ece,
    brier,
    logLoss,
    auc: aucRoc(labels, scores),
  };
}

function buildScoreBuckets(
  rows: PredictionRow[],
  thresholdPct: number,
): LearningScoreBucket[] {
  const settled = rows.filter((row) => isSettled(row.outcome));
  if (settled.length === 0) return [];
  const sorted = [...settled].sort((a, b) => a.mlScore - b.mlScore);
  const bucketCount = Math.min(
    6,
    Math.max(2, Math.floor(Math.sqrt(sorted.length))),
  );
  const buckets: LearningScoreBucket[] = [];
  for (let i = 0; i < bucketCount; i += 1) {
    const start = Math.floor((i * sorted.length) / bucketCount);
    const end = Math.floor(((i + 1) * sorted.length) / bucketCount);
    const slice = sorted.slice(start, end);
    const metric = buildMetric(`Q${i + 1}`, slice);
    const low = slice[0]?.mlScore ?? 0;
    const high = slice[slice.length - 1]?.mlScore ?? low;
    buckets.push({
      bucket:
        i === bucketCount - 1 &&
        thresholdPct > POLICY_EDGE_THRESHOLD_DENY_ALL_PCT
          ? `Q${i + 1} gate`
          : `Q${i + 1}`,
      low: round(low, 4) ?? 0,
      high: round(high, 4) ?? 0,
      count: slice.length,
      roiPct: metric.roiPct,
      winRatePct: metric.winRatePct,
      avgScore: round(average(slice.map((row) => row.mlScore)), 4),
      avgModelEdgePct: metric.avgModelEdgePct,
      avgClvPct: metric.avgClvPct,
    });
  }
  return buckets;
}

function monotonicity(buckets: LearningScoreBucket[]): number | null {
  const values = buckets
    .filter((bucket) => bucket.count > 0 && bucket.roiPct != null)
    .map((bucket) => bucket.roiPct as number);
  if (values.length < 2) return null;
  let pass = 0;
  for (let i = 0; i < values.length - 1; i += 1) {
    if (values[i + 1] >= values[i]) pass += 1;
  }
  return pass / (values.length - 1);
}

function extractTrainingReportNumber(
  report: unknown,
  key: string,
): number | null {
  if (!report || typeof report !== "object") return null;
  const value = (report as Record<string, unknown>)[key];
  return numOrNull(value);
}

function extractFeatureImportance(
  deployedReport: unknown,
  latestFeatureImportance: unknown,
): LearningFeatureImportance[] {
  const source =
    latestFeatureImportance && typeof latestFeatureImportance === "object"
      ? latestFeatureImportance
      : deployedReport &&
          typeof deployedReport === "object" &&
          (deployedReport as Record<string, unknown>).feature_importance
        ? (deployedReport as Record<string, unknown>).feature_importance
        : null;
  if (!source || typeof source !== "object") return [];
  return Object.entries(source as Record<string, unknown>)
    .map(([feature, value]) => ({
      feature,
      importance: numOrNull(value) ?? 0,
      rank: 0,
    }))
    .filter((row) => row.importance > 0)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 12)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function verdictLabel(code: LearningVerdict): string {
  const labels: Record<LearningVerdict, string> = {
    learning: "Learning",
    not_enough_settled_evidence: "Not enough settled evidence",
    not_beating_baseline: "Not beating baseline",
    calibration_weak: "Calibration weak",
    overfit_risk: "Overfit risk",
    feature_drift: "Feature drift",
    settlement_lag: "Settlement lag",
  };
  return labels[code];
}

function classifyVerdict(input: {
  settled: number;
  pending: number;
  mlGate: LearningMetric;
  simple: LearningMetric;
  roiLift: number | null;
  ece: number | null;
  monotonicity: number | null;
  overfitRisk: "low" | "medium" | "high" | "unknown";
  currentContractPredictions: number;
}): LearningSnapshotMetrics["verdict"] {
  const blockers: string[] = [];
  const total = input.settled + input.pending;
  const settlementLagPct = total > 0 ? (input.pending / total) * 100 : 0;

  let code: LearningVerdict = "learning";
  let reason =
    "Higher-scored settled predictions are beating the simple EV baseline.";

  if (input.currentContractPredictions === 0) {
    code = "feature_drift";
    reason = "No scored predictions match the current feature contract.";
    blockers.push("Current-contract prediction evidence is missing.");
  } else if (
    input.settled < MIN_SETTLED_FOR_VERDICT ||
    input.mlGate.sampleSize < MIN_GATE_FOR_VERDICT
  ) {
    code = "not_enough_settled_evidence";
    reason = `Need at least ${MIN_SETTLED_FOR_VERDICT} settled predictions and ${MIN_GATE_FOR_VERDICT} ML-gate settled rows.`;
    blockers.push("The settled sample is still too small for a hard verdict.");
  } else if (settlementLagPct >= SETTLEMENT_LAG_WARN_PCT) {
    code = "settlement_lag";
    reason = "Too many scored predictions are still pending settlement.";
    blockers.push(
      "Wait for more prediction rows to settle before trusting ROI.",
    );
  } else if (input.overfitRisk === "high") {
    code = "overfit_risk";
    reason = "Training diagnostics show elevated overfit risk.";
    blockers.push(
      "PBO or DSR indicates the trained policy may be too lucky in backtest.",
    );
  } else if ((input.ece ?? 0) > CALIBRATION_WARN_ECE) {
    code = "calibration_weak";
    reason =
      "Predicted probabilities are not matching observed outcomes closely enough.";
    blockers.push("Calibration error is above the warning threshold.");
  } else if ((input.roiLift ?? Number.NEGATIVE_INFINITY) <= 0) {
    code = "not_beating_baseline";
    reason =
      "The ML gate is not outperforming the simple EV baseline on settled rows.";
    blockers.push("ROI lift versus simple EV is not positive.");
  } else if ((input.monotonicity ?? 0) < 0.6) {
    code = "not_beating_baseline";
    reason = "Higher score buckets are not reliably producing better returns.";
    blockers.push("Score-bucket ROI is not directionally monotonic.");
  }

  return {
    code,
    label: verdictLabel(code),
    reason,
    confidence:
      input.settled >= 300 && input.mlGate.sampleSize >= 100
        ? "high"
        : input.settled >= 150
          ? "medium"
          : "low",
    blockers,
  };
}

function stableHash(metrics: LearningSnapshotMetrics): string {
  const material = {
    dataAsOf: metrics.dataAsOf,
    selectedModelVersion: metrics.selectedModelVersion,
    counts: metrics.counts,
    cohorts: metrics.cohorts,
    quality: metrics.quality,
    scoreBuckets: metrics.scoreBuckets,
    calibrationBuckets: metrics.calibrationBuckets,
    modelHistory: metrics.modelHistory.slice(0, 5),
    featureImportance: metrics.featureImportance.slice(0, 10),
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(material))
    .digest("hex");
}

export function toLearningSnapshotResponse(
  row: typeof mlLearningSnapshots.$inferSelect,
): LearningSnapshotResponse {
  return {
    id: row.id,
    snapshotHash: row.snapshotHash,
    modelVersion: row.modelVersion,
    verdict: row.verdict as LearningVerdict,
    verdictReason: row.verdictReason,
    trigger: row.trigger,
    dataAsOf: row.dataAsOf,
    createdAt: row.createdAt,
    settledPredictionCount: row.settledPredictionCount,
    pendingPredictionCount: row.pendingPredictionCount,
    scoredPredictionCount: row.scoredPredictionCount,
    baselineRoiPct: row.baselineRoiPct,
    simpleRoiPct: row.simpleRoiPct,
    mlGateRoiPct: row.mlGateRoiPct,
    roiLiftPct: row.roiLiftPct,
    calibrationError: row.calibrationError,
    brierScore: row.brierScore,
    logLoss: row.logLoss,
    aucRoc: row.aucRoc,
    scoreMonotonicity: row.scoreMonotonicity,
    metrics: row.metrics as LearningSnapshotMetrics,
  };
}

export async function buildLearningSnapshotMetrics(
  database: DbLike = db,
): Promise<LearningSnapshotMetrics> {
  const [predictionRows, modelRows, featureContractRows, exampleRows] =
    await Promise.all([
      database
        .select({
          id: mlPredictionAudit.id,
          scoredAt: mlPredictionAudit.scoredAt,
          modelVersion: mlPredictionAudit.modelVersion,
          mlScore: mlPredictionAudit.mlScore,
          modelEdgePct: mlPredictionAudit.modelEdgePct,
          baselineEvPct: mlPredictionAudit.baselineEvPct,
          softOdds: mlPredictionAudit.softOdds,
          softCommissionPct: mlPredictionAudit.softCommissionPct,
          marketType: mlPredictionAudit.marketType,
          outcome: mlPredictionAudit.outcome,
          pnl: mlPredictionAudit.pnl,
          clvPct: mlPredictionAudit.clvPct,
          settledAt: mlPredictionAudit.settledAt,
          placed: sql<boolean>`false`,
        })
        .from(mlPredictionAudit)
        .where(sql`${mlPredictionAudit.mlFeatureVersion} = ${ML_FEATURE_VERSION}
        AND ${mlPredictionAudit.mlFeatureCount} = ${ML_FEATURE_COUNT}
        AND ${mlPredictionAudit.mlFeatureNamesHash} = ${FEATURE_NAMES_HASH}`),
      database
        .select({
          version: mlModels.version,
          status: mlModels.status,
          trainingSamples: mlModels.trainingSamples,
          oosAucRoc: mlModels.oosAucRoc,
          oosLogLoss: mlModels.oosLogLoss,
          calibrationError: mlModels.calibrationError,
          deflatedSharpe: mlModels.deflatedSharpe,
          pbo: mlModels.pbo,
          featureImportance: mlModels.featureImportance,
          trainingReport: mlModels.trainingReport,
          permissionLevel: mlModels.permissionLevel,
          createdAt: mlModels.createdAt,
          deployedAt: mlModels.deployedAt,
        })
        .from(mlModels)
        .where(
          sql`${mlModels.version} > 0 AND ${mlModels.status} <> 'training'`,
        )
        .orderBy(desc(mlModels.createdAt))
        .limit(20),
      database.execute(sql`
      SELECT
        count(*) FILTER (
          WHERE ml_feature_version = ${ML_FEATURE_VERSION}
            AND ml_feature_count = ${ML_FEATURE_COUNT}
            AND ml_feature_names_hash = ${FEATURE_NAMES_HASH}
        )::int AS current_count,
        count(*)::int AS total_count
      FROM ${mlPredictionAudit}
      WHERE ml_score IS NOT NULL
    `),
      database
        .select({ count: sql<number>`count(*)::int` })
        .from(mlTrainingExamples)
        .where(
          sql`${mlTrainingExamples.label} IS NOT NULL
          AND ${mlTrainingExamples.featureVersion} = ${ML_FEATURE_VERSION}
          AND array_length(${mlTrainingExamples.features}, 1) = ${ML_FEATURE_COUNT}
          AND COALESCE((${mlTrainingExamples.features})[${FEATURE_SQL_INDEX.competition_tier}], -1.0) IN (1.0, 2.0, 3.0)`,
        ),
    ]);

  const rows = predictionRows.map((row) => ({
    ...row,
    mlScore: Number(row.mlScore),
    modelEdgePct: numOrNull(row.modelEdgePct),
    baselineEvPct: numOrNull(row.baselineEvPct),
    softOdds: Number(row.softOdds),
    softCommissionPct: Number(row.softCommissionPct),
    pnl: numOrNull(row.pnl),
    clvPct: numOrNull(row.clvPct),
  })) satisfies PredictionRow[];

  const latestDeployed = modelRows.find((row) => row.status === "deployed");
  const latestModel = latestDeployed ?? modelRows[0] ?? null;
  const threshold = latestDeployed
    ? resolvePolicyEdgeThreshold(latestDeployed.trainingReport).thresholdPct
    : POLICY_EDGE_THRESHOLD_DENY_ALL_PCT;
  const selectedModelVersion = latestModel?.version ?? null;

  const settledRows = rows.filter((row) => isSettled(row.outcome));
  const simpleRows = rows.filter(isSimpleRule);
  const mlGateRows = rows.filter((row) => isMlGate(row, threshold));
  const placedRows = rows.filter((row) => row.placed);
  const cohorts = {
    detectedBaseline: buildMetric("Detected baseline", rows),
    simpleEvCore: buildMetric("Simple EV core", simpleRows),
    mlScored: buildMetric("ML scored", rows),
    mlGate: buildMetric("ML gate", mlGateRows),
    placed: buildMetric("Placed bets", placedRows),
  };
  const roiLift =
    cohorts.mlGate.roiPct != null && cohorts.simpleEvCore.roiPct != null
      ? cohorts.mlGate.roiPct - cohorts.simpleEvCore.roiPct
      : null;
  const calibration = buildCalibration(rows);
  const scoreBuckets = buildScoreBuckets(rows, threshold);
  const scoreMonotonicity = monotonicity(scoreBuckets);
  const modelHistory: LearningModelHistoryRow[] = modelRows
    .slice()
    .reverse()
    .map((row) => ({
      version: row.version,
      status: row.status,
      trainingSamples: row.trainingSamples,
      oosAucRoc: numOrNull(row.oosAucRoc),
      oosLogLoss: numOrNull(row.oosLogLoss),
      calibrationError: numOrNull(row.calibrationError),
      deflatedSharpe: numOrNull(row.deflatedSharpe),
      pbo: numOrNull(row.pbo),
      policyRoiMean: extractTrainingReportNumber(
        row.trainingReport,
        "policy_roi_mean",
      ),
      simplePolicyRoiMean: extractTrainingReportNumber(
        row.trainingReport,
        "simple_policy_roi_mean",
      ),
      modelVsSimpleRoiDelta: extractTrainingReportNumber(
        row.trainingReport,
        "model_vs_simple_roi_delta",
      ),
      policySampleSize: extractTrainingReportNumber(
        row.trainingReport,
        "policy_sample_size",
      ),
      permissionLevel: row.permissionLevel,
      createdAt: row.createdAt,
      deployedAt: row.deployedAt,
    }));

  const overfitRisk =
    latestModel == null
      ? "unknown"
      : (numOrNull(latestModel.pbo) ?? 0) >= 0.3 ||
          (numOrNull(latestModel.deflatedSharpe) ?? 1) < 0.35
        ? "high"
        : (numOrNull(latestModel.pbo) ?? 0) >= 0.15 ||
            (numOrNull(latestModel.deflatedSharpe) ?? 1) < 0.6
          ? "medium"
          : "low";
  const featureContractRow =
    (featureContractRows.rows[0] as Record<string, unknown> | undefined) ?? {};
  const allVersionsMatch =
    Number(featureContractRow.current_count ?? 0) ===
    Number(featureContractRow.total_count ?? 0);
  const currentContractPredictions = Number(
    featureContractRow.current_count ?? 0,
  );
  const totalContractPredictions = Number(featureContractRow.total_count ?? 0);
  const excludedContractPredictions = Math.max(
    0,
    totalContractPredictions - currentContractPredictions,
  );
  const pendingRows = rows.filter((row) => row.outcome === "pending");
  const verdict = classifyVerdict({
    settled: settledRows.length,
    pending: pendingRows.length,
    mlGate: cohorts.mlGate,
    simple: cohorts.simpleEvCore,
    roiLift,
    ece: calibration.ece,
    monotonicity: scoreMonotonicity,
    overfitRisk,
    currentContractPredictions,
  });

  const latestSettledAt =
    settledRows
      .map((row) => row.settledAt)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
  const latestScoredAt =
    rows
      .map((row) => row.scoredAt)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
  const dataAsOf =
    latestSettledAt ?? latestScoredAt ?? new Date().toISOString();

  return {
    generatedAt: new Date().toISOString(),
    dataAsOf,
    latestSettledAt,
    latestScoredAt,
    selectedModelVersion,
    counts: {
      scoredPredictions: rows.length,
      settledPredictions: settledRows.length,
      pendingPredictions: pendingRows.length,
      mlGateSettled: cohorts.mlGate.sampleSize,
      simpleRuleSettled: cohorts.simpleEvCore.sampleSize,
      placedSettled: cohorts.placed.sampleSize,
      currentContractExamples: exampleRows[0]?.count ?? 0,
      excludedContractPredictions,
    },
    cohorts,
    verdict,
    quality: {
      roiLiftPct: round(roiLift, 4),
      calibrationError: round(calibration.ece, 6),
      brierScore: round(calibration.brier, 6),
      logLoss: round(calibration.logLoss, 6),
      aucRoc: round(calibration.auc, 6),
      scoreMonotonicity: round(scoreMonotonicity, 4),
      overfitRisk,
      settlementLagPct:
        rows.length > 0
          ? (round((pendingRows.length / rows.length) * 100, 2) ?? 0)
          : 0,
    },
    scoreBuckets,
    calibrationBuckets: calibration.buckets,
    modelHistory,
    featureImportance: extractFeatureImportance(
      latestModel?.trainingReport,
      latestModel?.featureImportance,
    ),
    notes: [
      "Real placed-bet evidence is not available yet, so settled shadow-scored predictions are the primary truth source.",
      "The deterministic verdict is metric-based. DeepSeek explanations are commentary only.",
      ...(allVersionsMatch
        ? []
        : [
            `${excludedContractPredictions} old-contract scored predictions are excluded from this learning snapshot.`,
          ]),
    ],
  };
}

export async function createOrReuseLearningSnapshot(
  options: { trigger?: string } = {},
): Promise<LearningSnapshotResponse> {
  const metrics = await buildLearningSnapshotMetrics(db);
  const snapshotHash = stableHash(metrics);

  const [existing] = await db
    .select()
    .from(mlLearningSnapshots)
    .where(sql`${mlLearningSnapshots.snapshotHash} = ${snapshotHash}`)
    .limit(1);
  if (existing) return toLearningSnapshotResponse(existing);

  const [created] = await db
    .insert(mlLearningSnapshots)
    .values({
      snapshotHash,
      modelVersion: metrics.selectedModelVersion,
      verdict: metrics.verdict.code,
      verdictReason: metrics.verdict.reason,
      trigger: options.trigger ?? "manual",
      dataAsOf: metrics.dataAsOf,
      settledPredictionCount: metrics.counts.settledPredictions,
      pendingPredictionCount: metrics.counts.pendingPredictions,
      scoredPredictionCount: metrics.counts.scoredPredictions,
      baselineRoiPct: metrics.cohorts.detectedBaseline.roiPct,
      simpleRoiPct: metrics.cohorts.simpleEvCore.roiPct,
      mlGateRoiPct: metrics.cohorts.mlGate.roiPct,
      roiLiftPct: metrics.quality.roiLiftPct,
      calibrationError: metrics.quality.calibrationError,
      brierScore: metrics.quality.brierScore,
      logLoss: metrics.quality.logLoss,
      aucRoc: metrics.quality.aucRoc,
      scoreMonotonicity: metrics.quality.scoreMonotonicity,
      metrics,
    })
    .onConflictDoNothing({ target: mlLearningSnapshots.snapshotHash })
    .returning();

  if (created) return toLearningSnapshotResponse(created);

  const [raceWinner] = await db
    .select()
    .from(mlLearningSnapshots)
    .where(sql`${mlLearningSnapshots.snapshotHash} = ${snapshotHash}`)
    .limit(1);
  if (!raceWinner) throw new Error("Failed to persist ML learning snapshot");
  return toLearningSnapshotResponse(raceWinner);
}

export async function getLatestLearningSnapshot(): Promise<LearningSnapshotResponse | null> {
  const [row] = await db
    .select()
    .from(mlLearningSnapshots)
    .orderBy(desc(mlLearningSnapshots.createdAt))
    .limit(1);
  return row ? toLearningSnapshotResponse(row) : null;
}

export async function hasLearningEvidence(): Promise<boolean> {
  const [row] = await db
    .select({ id: mlPredictionAudit.id })
    .from(mlPredictionAudit)
    .where(isNotNull(mlPredictionAudit.mlScore))
    .limit(1);
  return Boolean(row);
}
