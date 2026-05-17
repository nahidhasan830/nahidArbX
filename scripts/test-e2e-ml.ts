import "dotenv/config";

/**
 * ML Optimizer end-to-end test from the frontend point of view.
 *
 * This script intentionally avoids Playwright/browser automation. It loads the
 * ML Optimizer page shell, exercises the HTTP endpoints consumed by React,
 * optionally triggers the real retrain endpoint, waits for a terminal model
 * status, and then validates every current training example in Postgres.
 *
 * Usage:
 *   npm run dev
 *   ENABLE_E2E_CLOUD_RUN=1 npx tsx scripts/test-e2e-ml.ts
 *
 * Optional:
 *   BASE_URL=http://127.0.0.1:3000
 *   E2E_TIMEOUT_MINUTES=45
 *   E2E_POLL_SECONDS=15
 */

if (!process.env.ENABLE_E2E_CLOUD_RUN) {
  console.error(
    "This script can trigger a real Cloud Build + Cloud Run training job.\n" +
      "Set ENABLE_E2E_CLOUD_RUN=1 to proceed.",
  );
  process.exit(1);
}

import { db, ensureDbReady } from "@/lib/db/client";
import { mlModels } from "@/lib/db/schema";
import { FEATURE_NAMES_HASH } from "@/lib/ml/features";
import { ML_FEATURE_COUNT, ML_FEATURE_VERSION } from "@/lib/shared/constants";
import { desc, sql } from "drizzle-orm";

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
const TIMEOUT_MINUTES = Number(process.env.E2E_TIMEOUT_MINUTES ?? 45);
const POLL_SECONDS = Number(process.env.E2E_POLL_SECONDS ?? 15);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchJson(path: string, method = "GET"): Promise<JsonRecord> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`${method} ${path} failed with HTTP ${res.status}: ${text}`);
  }
  if (!isRecord(body)) throw new Error(`${path} did not return a JSON object`);
  return body;
}

async function fetchPage(path: string): Promise<void> {
  const res = await fetch(`${BASE_URL}${path}`, {
    cache: "no-store",
    headers: { accept: "text/html" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${path} page failed with HTTP ${res.status}`);
  }
  console.log(
    `[page] ${path}: HTTP ${res.status}, ${text.length.toLocaleString()} bytes`,
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (typeof value === "bigint") return Number(value);
  return 0;
}

function labelForOutcome(outcome: unknown): "positive" | "negative" | null {
  if (outcome === "won" || outcome === "half_won") return "positive";
  if (outcome === "lost" || outcome === "half_lost") return "negative";
  return null;
}

function assertFiniteFeatureArray(
  features: unknown,
  id: string,
  issues: string[],
): number[] | null {
  if (!Array.isArray(features)) {
    issues.push(`${id}: features missing`);
    return null;
  }
  if (features.length !== ML_FEATURE_COUNT) {
    issues.push(`${id}: feature length ${features.length}, expected ${ML_FEATURE_COUNT}`);
    return null;
  }
  const nums = features.map(Number);
  const badIndex = nums.findIndex((n) => !Number.isFinite(n));
  if (badIndex >= 0) {
    issues.push(`${id}: feature[${badIndex}] is not finite`);
    return null;
  }
  return nums;
}

async function printRealDataAvailability(): Promise<void> {
  const result = await db.execute(sql`
    SELECT
      count(*)::int AS total_bets,
      count(*) FILTER (WHERE ml_features IS NOT NULL)::int AS bets_with_features,
      count(*) FILTER (
        WHERE outcome NOT IN ('pending', 'void')
          AND ml_features IS NOT NULL
          AND ml_feature_version = ${ML_FEATURE_VERSION}
          AND ml_feature_names_hash = ${FEATURE_NAMES_HASH}
          AND array_length(ml_features, 1) = ${ML_FEATURE_COUNT}
          AND sharp_true_prob > 0
          AND sharp_true_prob < 1
          AND soft_odds > 1.01
          AND ml_features[22] IN (1.0, 2.0, 3.0)
      )::int AS qualified_bets,
      (SELECT count(*)::int FROM ml_training_examples WHERE label IN ('positive', 'negative')) AS labeled_examples,
      (SELECT count(*)::int FROM ml_models WHERE version > 0) AS trained_models
    FROM bets
  `);
  const row = result.rows[0] as JsonRecord;
  console.log("\n[real-data]");
  console.log(`  total bets:          ${row.total_bets}`);
  console.log(`  bets with features:  ${row.bets_with_features}`);
  console.log(`  qualified bets:      ${row.qualified_bets}`);
  console.log(`  labeled examples:    ${row.labeled_examples}`);
  console.log(`  model rows:          ${row.trained_models}`);
}

async function triggerTraining(): Promise<string> {
  const before = await fetchJson("/api/ml/pipeline");
  const training = before.training as JsonRecord | undefined;
  if (training && asNumber(training.modelsInTraining) > 0) {
    const active = training.activeTraining as JsonRecord | null | undefined;
    const modelId = String(active?.modelId ?? "already-running");
    console.log(`[train] existing training run detected: ${modelId}`);
    return modelId;
  }

  const res = await fetchJson("/api/ml/retrain", "POST");
  const modelId = String(res.modelId ?? "");
  if (!modelId) throw new Error("/api/ml/retrain did not return modelId");
  console.log(`[train] triggered modelId=${modelId}`);
  return modelId;
}

async function waitForTraining(modelId: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MINUTES * 60_000;
  let latestStatus = "training";

  while (Date.now() < deadline) {
    await sleep(POLL_SECONDS * 1000);
    const pipeline = await fetchJson("/api/ml/pipeline");
    const training = pipeline.training as JsonRecord;
    const active = training.activeTraining as JsonRecord | null;
    const modelsInTraining = asNumber(training.modelsInTraining);
    const latestModel = training.latestModel as JsonRecord | null;
    latestStatus = String(latestModel?.status ?? active?.status ?? latestStatus);

    console.log(
      `[train] polling: inTraining=${modelsInTraining}, latestStatus=${latestStatus}`,
    );

    if (modelsInTraining === 0 && !active) return;
    if (latestStatus === "failed" || latestStatus === "rejected") return;
  }

  throw new Error(`Training timed out after ${TIMEOUT_MINUTES} minutes (${modelId})`);
}

async function reportLatestModel(): Promise<void> {
  const [latest] = await db
    .select()
    .from(mlModels)
    .orderBy(desc(mlModels.createdAt))
    .limit(1);

  if (!latest) throw new Error("No ml_models row exists after training.");

  console.log("\n[latest-model]");
  console.log(`  id:        ${latest.id}`);
  console.log(`  version:   ${latest.version}`);
  console.log(`  status:    ${latest.status}`);
  console.log(`  samples:   ${latest.trainingSamples}`);
  console.log(`  AUC:       ${latest.oosAucRoc ?? "n/a"}`);
  console.log(`  DSR:       ${latest.deflatedSharpe ?? "n/a"}`);
  console.log(`  ROI:       ${latest.oosRoiMean ?? "n/a"}`);
  console.log(`  authority: ${latest.permissionLevel ?? "observe"}`);

  if (latest.status === "failed" || latest.status === "rejected") {
    console.log(
      `  reasons:   ${JSON.stringify(latest.rejectionReasons ?? [], null, 2)}`,
    );
  }
}

async function validateEveryTrainingExample(): Promise<void> {
  const result = await db.execute(sql`
    SELECT
      m.id,
      m.source_bet_id,
      m.example_type,
      m.features,
      m.feature_version,
      m.label,
      m.outcome,
      m.sample_weight,
      b.outcome AS bet_outcome,
      b.ml_feature_version AS bet_feature_version,
      b.ml_feature_count AS bet_feature_count,
      b.ml_feature_names_hash AS bet_feature_names_hash
    FROM ml_training_examples m
    LEFT JOIN bets b ON b.id = m.source_bet_id
    WHERE m.label IN ('positive', 'negative')
      AND m.features IS NOT NULL
    ORDER BY m.id ASC
  `);

  const issues: string[] = [];
  const duplicateKeys = new Set<string>();
  const seenKeys = new Set<string>();
  let currentVersion = 0;
  let currentClean = 0;

  for (const row of result.rows as JsonRecord[]) {
    const id = String(row.id);
    const sourceBetId = row.source_bet_id == null ? null : String(row.source_bet_id);
    const exampleType = String(row.example_type);
    const key = `${sourceBetId ?? id}|${exampleType}`;
    if (seenKeys.has(key)) duplicateKeys.add(key);
    seenKeys.add(key);

    if (asNumber(row.feature_version) === ML_FEATURE_VERSION) currentVersion++;

    const features = assertFiniteFeatureArray(row.features, id, issues);
    if (features) {
      const sharpProb = features[1];
      const adjustedOdds = features[3];
      const tier = features[21];
      if (!(sharpProb > 0 && sharpProb < 1)) {
        issues.push(`${id}: sharp_true_prob out of range (${sharpProb})`);
      }
      if (!(adjustedOdds > 1.01)) {
        issues.push(`${id}: adjusted_soft_odds too low (${adjustedOdds})`);
      }
      if (![1, 2, 3].includes(tier)) {
        issues.push(`${id}: competition_tier invalid (${tier})`);
      }
    }

    const expectedLabel = labelForOutcome(row.outcome);
    if (expectedLabel !== row.label) {
      issues.push(`${id}: label ${row.label} does not match outcome ${row.outcome}`);
    }

    if (sourceBetId) {
      const sourceExpectedLabel = labelForOutcome(row.bet_outcome);
      if (sourceExpectedLabel !== null && sourceExpectedLabel !== row.label) {
        issues.push(
          `${id}: label ${row.label} does not match source bet outcome ${row.bet_outcome}`,
        );
      }
      if (asNumber(row.bet_feature_version) !== ML_FEATURE_VERSION) {
        issues.push(`${id}: source bet feature version is stale`);
      }
      if (asNumber(row.bet_feature_count) !== ML_FEATURE_COUNT) {
        issues.push(`${id}: source bet feature count is wrong`);
      }
      if (row.bet_feature_names_hash !== FEATURE_NAMES_HASH) {
        issues.push(`${id}: source bet feature hash mismatch`);
      }
    }

    const weight = asNumber(row.sample_weight);
    if (!(weight > 0 && weight <= 10)) {
      issues.push(`${id}: sample_weight out of expected range (${weight})`);
    }

    if (asNumber(row.feature_version) === ML_FEATURE_VERSION && features) {
      currentClean++;
    }
  }

  for (const dup of duplicateKeys) {
    issues.push(`duplicate example key: ${dup}`);
  }

  console.log("\n[data-audit]");
  console.log(`  labeled examples scanned: ${result.rows.length.toLocaleString()}`);
  console.log(`  current-version rows:     ${currentVersion.toLocaleString()}`);
  console.log(`  clean current rows:       ${currentClean.toLocaleString()}`);
  console.log(`  issues found:             ${issues.length.toLocaleString()}`);

  if (issues.length > 0) {
    for (const issue of issues.slice(0, 50)) console.log(`  - ${issue}`);
    if (issues.length > 50) {
      console.log(`  ... ${issues.length - 50} more issues omitted`);
    }
    throw new Error("Training data audit found reliability issues.");
  }
}

async function observeFrontendContracts(): Promise<void> {
  await fetchPage("/lab/ml");
  const [pipeline, models, trainingData] = await Promise.all([
    fetchJson("/api/ml/pipeline"),
    fetchJson("/api/ml/models"),
    fetchJson("/api/ml/training-data"),
  ]);

  console.log("\n[frontend-contract]");
  console.log(
    `  pipeline models:      ${asNumber((pipeline.training as JsonRecord).totalModels)}`,
  );
  console.log(
    `  models returned:      ${(models.models as unknown[] | undefined)?.length ?? 0}`,
  );
  console.log(
    `  auto-retrain growth:  ≥${asNumber((pipeline.scheduler as JsonRecord).growthThresholdPct)}%`,
  );
  console.log(
    `  training rows:        ${asNumber((trainingData.summary as JsonRecord).total)}`,
  );
}

async function main(): Promise<void> {
  await ensureDbReady();
  console.log("=== ML Optimizer End-to-End Test ===");
  console.log(`[config] baseUrl=${BASE_URL}`);

  await observeFrontendContracts();
  await printRealDataAvailability();
  const modelId = await triggerTraining();
  await waitForTraining(modelId);
  await observeFrontendContracts();
  await reportLatestModel();
  await validateEveryTrainingExample();

  console.log("\n=== ML Optimizer E2E completed ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nE2E failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
