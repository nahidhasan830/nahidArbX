/**
 * UI-perspective ML optimizer pipeline test.
 *
 * This is intentionally HTTP-level instead of Playwright/browser-based:
 * AGENTS.md forbids opening a browser for verification. It exercises the
 * endpoints the ML Optimizer page depends on and validates the JSON contract
 * the React Query hooks consume.
 *
 * Usage:
 *   npm run dev
 *   npm run test:ml-ui
 *
 * Optional:
 *   ML_UI_BASE_URL=http://127.0.0.1:3000 npm run test:ml-ui
 */

import { ML_FEATURE_COUNT, ML_FEATURE_VERSION } from "@/lib/shared/constants";

const baseUrl = (process.env.ML_UI_BASE_URL ?? "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);

interface FetchResult {
  path: string;
  status: number;
  body: unknown;
}

const failures: string[] = [];
const warnings: string[] = [];

function fail(message: string): void {
  failures.push(message);
}

function warn(message: string): void {
  warnings.push(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(
  value: unknown,
  path: string,
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    fail(`${path} must be an object`);
    return null;
  }
  return value;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(`${path} must be an array`);
    return [];
  }
  return value;
}

function expectNumber(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${path} must be a finite number`);
  }
}

function expectNullableNumber(value: unknown, path: string): void {
  if (
    value !== null &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    fail(`${path} must be null or a finite number`);
  }
}

function expectString(value: unknown, path: string): void {
  if (typeof value !== "string") {
    fail(`${path} must be a string`);
  }
}

function expectNullableString(value: unknown, path: string): void {
  if (value !== null && typeof value !== "string") {
    fail(`${path} must be null or a string`);
  }
}

function expectBoolean(value: unknown, path: string): void {
  if (typeof value !== "boolean") {
    fail(`${path} must be a boolean`);
  }
}

async function fetchJson(
  path: string,
  okStatuses = new Set([200]),
): Promise<FetchResult | null> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  } catch (err) {
    fail(
      `${path} could not be reached at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  let body: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      fail(`${path} returned non-JSON response with HTTP ${res.status}`);
      return { path, status: res.status, body: text };
    }
  }

  if (!okStatuses.has(res.status)) {
    const error =
      isRecord(body) && typeof body.error === "string" ? `: ${body.error}` : "";
    fail(`${path} returned HTTP ${res.status}${error}`);
  }

  return { path, status: res.status, body };
}

async function fetchPage(path: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      cache: "no-store",
      headers: { accept: "text/html" },
    });
  } catch (err) {
    fail(
      `${path} page could not be reached at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const text = await res.text();
  if (!res.ok) {
    fail(`${path} page returned HTTP ${res.status}`);
    return;
  }
  if (!text.includes("/api/ml/pipeline") && !text.includes("ML Optimizer")) {
    warn(
      `${path} page returned HTML, but the optimizer marker text was not found in the initial payload.`,
    );
  }
}

function migrationHintFor(result: FetchResult | null): void {
  if (
    !result ||
    !isRecord(result.body) ||
    typeof result.body.error !== "string"
  )
    return;
  const msg = result.body.error;
  if (
    msg.includes("does not exist") &&
    (msg.includes("ml_feature") ||
      msg.includes("ml_models") ||
      msg.includes("competition_enrichments") ||
      msg.includes("ml_training_examples"))
  ) {
    warn(
      `${result.path} looks migration-related. Run: npx tsx scripts/apply-pending-migrations.ts`,
    );
  }
}

function validatePipeline(body: unknown): void {
  const root = expectRecord(body, "/api/ml/pipeline");
  if (!root) return;

  const dataCollection = expectRecord(
    root.dataCollection,
    "pipeline.dataCollection",
  );
  if (dataCollection) {
    for (const key of [
      "totalBets",
      "betsWithFeatures",
      "settledWithFeatures",
      "coldStartThreshold",
      "coldStartProgress",
      "recentFeatureRate",
    ]) {
      expectNumber(dataCollection[key], `pipeline.dataCollection.${key}`);
    }
    expectBoolean(
      dataCollection.featureExtractionHealthy,
      "pipeline.dataCollection.featureExtractionHealthy",
    );

    const totalBets = dataCollection.totalBets;
    const betsWithFeatures = dataCollection.betsWithFeatures;
    const settledWithFeatures = dataCollection.settledWithFeatures;
    const coldStartProgress = dataCollection.coldStartProgress;
    if (
      typeof totalBets === "number" &&
      typeof betsWithFeatures === "number" &&
      betsWithFeatures > totalBets
    ) {
      fail("pipeline.dataCollection.betsWithFeatures cannot exceed totalBets");
    }
    if (
      typeof betsWithFeatures === "number" &&
      typeof settledWithFeatures === "number" &&
      settledWithFeatures > betsWithFeatures
    ) {
      fail(
        "pipeline.dataCollection.settledWithFeatures cannot exceed betsWithFeatures",
      );
    }
    if (
      typeof coldStartProgress === "number" &&
      (coldStartProgress < 0 || coldStartProgress > 100)
    ) {
      fail(
        "pipeline.dataCollection.coldStartProgress must be between 0 and 100",
      );
    }
  }

  const training = expectRecord(root.training, "pipeline.training");
  if (training) {
    for (const key of [
      "totalModels",
      "modelsInTraining",
      "newDataSinceLastTrain",
      "examplesUntilRetrain",
      "retrainStep",
    ]) {
      expectNumber(training[key], `pipeline.training.${key}`);
    }
    expectBoolean(training.readyToRetrain, "pipeline.training.readyToRetrain");
    if (training.deployedModel !== null)
      expectRecord(training.deployedModel, "pipeline.training.deployedModel");
    if (training.latestModel !== null)
      expectRecord(training.latestModel, "pipeline.training.latestModel");
  }

  const inference = expectRecord(root.inference, "pipeline.inference");
  if (inference) {
    expectBoolean(inference.modelLoaded, "pipeline.inference.modelLoaded");
    expectNullableNumber(
      inference.modelVersion,
      "pipeline.inference.modelVersion",
    );
    expectNumber(inference.totalScored, "pipeline.inference.totalScored");
    expectNumber(inference.avgInferenceMs, "pipeline.inference.avgInferenceMs");
    if (inference.error !== undefined)
      expectString(inference.error, "pipeline.inference.error");
  }

  const scheduler = expectRecord(root.scheduler, "pipeline.scheduler");
  if (scheduler) {
    expectBoolean(scheduler.active, "pipeline.scheduler.active");
    expectNullableNumber(scheduler.lastTickAt, "pipeline.scheduler.lastTickAt");
    expectNumber(
      scheduler.totalRetrainTriggers,
      "pipeline.scheduler.totalRetrainTriggers",
    );
    expectNullableString(scheduler.lastError, "pipeline.scheduler.lastError");
    expectNumber(scheduler.retrainStep, "pipeline.scheduler.retrainStep");
  }

  const deploymentGate = expectRecord(
    root.deploymentGate,
    "pipeline.deploymentGate",
  );
  if (deploymentGate) {
    expectString(
      deploymentGate.permissionLevel,
      "pipeline.deploymentGate.permissionLevel",
    );
    expectNullableNumber(
      deploymentGate.modelVersion,
      "pipeline.deploymentGate.modelVersion",
    );
    expectBoolean(deploymentGate.canGate, "pipeline.deploymentGate.canGate");
    expectBoolean(
      deploymentGate.canReduceStake,
      "pipeline.deploymentGate.canReduceStake",
    );
    expectBoolean(
      deploymentGate.canIncreaseStake,
      "pipeline.deploymentGate.canIncreaseStake",
    );
    expectNullableString(
      deploymentGate.lastRefreshedAt,
      "pipeline.deploymentGate.lastRefreshedAt",
    );
  }

  expectString(root.scoringMode, "pipeline.scoringMode");

  const featureContract = expectRecord(
    root.featureContract,
    "pipeline.featureContract",
  );
  if (featureContract) {
    expectNumber(
      featureContract.currentVersion,
      "pipeline.featureContract.currentVersion",
    );
    expectNumber(
      featureContract.currentFeatureCount,
      "pipeline.featureContract.currentFeatureCount",
    );
    expectString(
      featureContract.currentNamesHash,
      "pipeline.featureContract.currentNamesHash",
    );
    expectArray(
      featureContract.versionDistribution,
      "pipeline.featureContract.versionDistribution",
    );
    expectArray(
      featureContract.lengthDistribution,
      "pipeline.featureContract.lengthDistribution",
    );
    expectBoolean(
      featureContract.allVersionsMatch,
      "pipeline.featureContract.allVersionsMatch",
    );
    expectBoolean(
      featureContract.allLengthsMatch,
      "pipeline.featureContract.allLengthsMatch",
    );
    expectBoolean(
      featureContract.allSemanticChecksPass,
      "pipeline.featureContract.allSemanticChecksPass",
    );
    const semanticChecks = expectRecord(
      featureContract.semanticChecks,
      "pipeline.featureContract.semanticChecks",
    );
    if (semanticChecks) {
      for (const key of [
        "betsWithCurrentFeatures",
        "badCompetitionTier",
        "trainableSettledCurrentFeatures",
        "badTrainableCompetitionTier",
        "labeledExamples",
        "badLabeledCompetitionTier",
        "cleanLabeledExamples",
        "badLabeledNonPositiveEv",
      ]) {
        expectNumber(
          semanticChecks[key],
          `pipeline.featureContract.semanticChecks.${key}`,
        );
      }
      expectBoolean(
        semanticChecks.semanticPass,
        "pipeline.featureContract.semanticChecks.semanticPass",
      );
    }
    if (featureContract.currentVersion !== ML_FEATURE_VERSION) {
      fail(
        `pipeline.featureContract.currentVersion must be ${ML_FEATURE_VERSION}`,
      );
    }
    if (featureContract.currentFeatureCount !== ML_FEATURE_COUNT) {
      fail(
        `pipeline.featureContract.currentFeatureCount must be ${ML_FEATURE_COUNT}`,
      );
    }
  }

  const scoreBucketROI = expectArray(
    root.scoreBucketROI,
    "pipeline.scoreBucketROI",
  );
  if (scoreBucketROI.length !== 6) {
    fail("pipeline.scoreBucketROI must contain 6 performance buckets");
  }
  scoreBucketROI.forEach((bucket, i) => {
    const b = expectRecord(bucket, `pipeline.scoreBucketROI[${i}]`);
    if (!b) return;
    expectString(b.bucket, `pipeline.scoreBucketROI[${i}].bucket`);
    expectNumber(b.count, `pipeline.scoreBucketROI[${i}].count`);
    expectNumber(b.avgPnl, `pipeline.scoreBucketROI[${i}].avgPnl`);
    expectNumber(b.avgClv, `pipeline.scoreBucketROI[${i}].avgClv`);
    expectNumber(b.winRate, `pipeline.scoreBucketROI[${i}].winRate`);
    if (b.avgEdge !== undefined) {
      expectNullableNumber(b.avgEdge, `pipeline.scoreBucketROI[${i}].avgEdge`);
    }
  });

  const paperEvaluation = expectRecord(
    root.paperEvaluation,
    "pipeline.paperEvaluation",
  );
  if (paperEvaluation) {
    expectRecord(
      paperEvaluation.semanticHealth,
      "pipeline.paperEvaluation.semanticHealth",
    );
    const simpleRule = expectRecord(
      paperEvaluation.simpleRule,
      "pipeline.paperEvaluation.simpleRule",
    );
    if (simpleRule) {
      expectNumber(simpleRule.minEvPct, "pipeline.paperEvaluation.simpleRule.minEvPct");
      expectArray(
        simpleRule.marketTypes,
        "pipeline.paperEvaluation.simpleRule.marketTypes",
      );
    }
    expectNumber(
      paperEvaluation.mlMinScore,
      "pipeline.paperEvaluation.mlMinScore",
    );
    expectNumber(
      paperEvaluation.mlModelEdgeThresholdPct,
      "pipeline.paperEvaluation.mlModelEdgeThresholdPct",
    );
    const metrics = expectRecord(
      paperEvaluation.metrics,
      "pipeline.paperEvaluation.metrics",
    );
    if (metrics) {
      for (const key of [
        "detectedBaseline",
        "simpleEvCore",
        "mlScored",
        "mlGate",
      ]) {
        const metric = expectRecord(
          metrics[key],
          `pipeline.paperEvaluation.metrics.${key}`,
        );
        if (!metric) continue;
        expectString(
          metric.label,
          `pipeline.paperEvaluation.metrics.${key}.label`,
        );
        expectNumber(
          metric.sampleSize,
          `pipeline.paperEvaluation.metrics.${key}.sampleSize`,
        );
      }
    }
    const verdict = expectRecord(
      paperEvaluation.verdict,
      "pipeline.paperEvaluation.verdict",
    );
    if (verdict) {
      expectBoolean(
        verdict.enoughMlGateSamples,
        "pipeline.paperEvaluation.verdict.enoughMlGateSamples",
      );
      expectBoolean(
        verdict.mlBeatsSimpleRule,
        "pipeline.paperEvaluation.verdict.mlBeatsSimpleRule",
      );
    }
    expectArray(paperEvaluation.trend, "pipeline.paperEvaluation.trend");
  }

  expectArray(root.rejectedModels, "pipeline.rejectedModels");
}

function validateModels(body: unknown, pipelineBody: unknown): void {
  const root = expectRecord(body, "/api/ml/models");
  if (!root) return;
  const models = expectArray(root.models, "models.models");
  models.forEach((model, i) => {
    const m = expectRecord(model, `models.models[${i}]`);
    if (!m) return;
    expectString(m.id, `models.models[${i}].id`);
    expectNumber(m.version, `models.models[${i}].version`);
    expectString(m.status, `models.models[${i}].status`);
    expectNumber(m.trainingSamples, `models.models[${i}].trainingSamples`);
  });

  const pipeline =
    isRecord(pipelineBody) && isRecord(pipelineBody.training)
      ? pipelineBody.training
      : null;
  if (
    pipeline &&
    typeof pipeline.totalModels === "number" &&
    pipeline.totalModels !== models.length
  ) {
    fail(
      `/api/ml/models returned ${models.length} rows but pipeline.training.totalModels is ${pipeline.totalModels}`,
    );
  }
}

function validateStatus(body: unknown): void {
  const root = expectRecord(body, "/api/ml/status");
  if (!root) return;
  expectBoolean(root.modelLoaded, "status.modelLoaded");
  expectNullableNumber(root.modelVersion, "status.modelVersion");
  expectNumber(root.featureCount, "status.featureCount");
  expectNumber(root.totalScored, "status.totalScored");
  expectNumber(root.avgInferenceMs, "status.avgInferenceMs");
  expectNumber(root.lastInferenceMs, "status.lastInferenceMs");
  if (root.error !== undefined) expectString(root.error, "status.error");
}

async function main(): Promise<void> {
  console.log(`[ml-ui] Testing ML Optimizer UI contract at ${baseUrl}`);

  await fetchPage("/lab/ml");

  const pipeline = await fetchJson("/api/ml/pipeline");
  migrationHintFor(pipeline);
  if (pipeline?.status === 200) validatePipeline(pipeline.body);

  const models = await fetchJson("/api/ml/models");
  migrationHintFor(models);
  if (models?.status === 200) validateModels(models.body, pipeline?.body);

  const status = await fetchJson("/api/ml/status", new Set([200, 503]));
  if (status?.status === 503) {
    warn(
      "/api/ml/status reports engine unreachable; the dashboard should still render via /api/ml/pipeline fallback data.",
    );
  }
  if (status) validateStatus(status.body);

  if (warnings.length > 0) {
    console.log("\nWarnings:");
    for (const message of warnings) console.log(`  - ${message}`);
  }

  if (failures.length > 0) {
    console.error("\nML UI pipeline test failed:");
    for (const message of failures) console.error(`  - ${message}`);
    process.exit(1);
  }

  console.log("\nML UI pipeline test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
