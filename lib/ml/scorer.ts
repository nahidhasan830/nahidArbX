/**
 * ML Scorer — Vertex AI Prediction (Engine-Only)
 *
 * Cloud-managed inference via Vertex AI Prediction endpoint.
 * Replaces local ONNX scoring with managed LightGBM model deployment.
 *
 * Configuration:
 *   VERTEX_PREDICTION_ENDPOINT — optional endpoint id, resource name, or URL
 *   ml_models.vertex_endpoint_name — fallback written by the trainer
 *   GCP_PROJECT_ID, GCP_REGION — already configured
 *
 * ⚠ PROCESS ISOLATION: This module must NEVER be imported by Next.js
 * API routes or React Server Components.
 */

import { singleton } from "@/lib/util/singleton";
import { logger } from "@/lib/shared/logger";
import { FEATURE_COUNT } from "./feature-contract";
import {
  getVertexPredictionEndpoint,
  predictBatch,
  setVertexPredictionEndpoint,
} from "./vertex-prediction-client";

// ============================================
// State — singleton for HMR safety
// ============================================

interface ScorerState {
  loadAttempted: boolean;
  modelVersion: number | null;
  watcherTimer: ReturnType<typeof setInterval> | null;
  /** Total batch entries we tried to score, including failures. */
  totalScoringAttempts: number;
  /** Total batch entries that returned a non-null calibrated score. */
  totalScored: number;
  /** Wall-clock ms of the last predictBatch round-trip (0 if none yet). */
  lastInferenceMs: number;
  /** Total wall-clock ms across all predictBatch round-trips. */
  totalInferenceMs: number;
  /** Number of predictBatch round-trips (used to derive avg latency). */
  totalInferenceCalls: number;
  /** Current Vertex AI Prediction endpoint resource or URL. */
  vertexEndpoint: string | null;
}

const state = singleton(
  "ml:scorer",
  (): ScorerState => ({
    loadAttempted: false,
    modelVersion: null,
    watcherTimer: null,
    totalScoringAttempts: 0,
    totalScored: 0,
    lastInferenceMs: 0,
    totalInferenceMs: 0,
    totalInferenceCalls: 0,
    vertexEndpoint: null,
  }),
);

const MODEL_WATCH_INTERVAL_MS = 60_000;

// ============================================
// Public API
// ============================================

export function isModelLoaded(): boolean {
  // Vertex AI endpoint is always "loaded" once configured or discovered.
  return !!getVertexPredictionEndpoint();
}

export async function ensureModel(): Promise<boolean> {
  if (state.loadAttempted) return isModelLoaded();
  state.loadAttempted = true;

  const endpoint = await refreshDeployedModelState(true);
  const endpointConfigured = !!endpoint;
  if (!endpointConfigured) {
    logger.info(
      "MLScorer",
      "No Vertex prediction endpoint configured or deployed — scoring returns null (fail-open).",
    );
  } else {
    logger.info(
      "MLScorer",
      `Vertex AI Prediction endpoint configured: ${endpoint}`,
    );
    // Probe through scoreBatch so the inference dashboard reflects the
    // startup check, even before a live value bet is warm enough to score.
    const probe = await scoreBatch([Array(FEATURE_COUNT).fill(0)]);
    const healthy = probe.length === 1 && probe[0] !== null;
    if (healthy) {
      logger.info("MLScorer", "Vertex AI endpoint health check passed");
    } else {
      logger.warn(
        "MLScorer",
        "Vertex AI endpoint health check failed — scoring will return null",
      );
    }
  }

  startModelWatcher();
  return endpointConfigured;
}

/**
 * Score a batch of feature vectors via Vertex AI Prediction endpoint.
 * Returns calibrated P(win) [0, 1] for each input, or null on failure.
 *
 * Counter discipline:
 *   - `totalScoringAttempts` increments by `featureArrays.length` for every
 *     call so the dashboard shows real call volume.
 *   - `totalScored` increments only by the count of non-null elements in the
 *     response. A failed endpoint does not inflate the success counter.
 *   - `lastInferenceMs` and `totalInferenceMs` are wall-clock measurements
 *     of the predictBatch round-trip.
 */
export async function scoreBatch(
  featureArrays: number[][],
): Promise<(number | null)[]> {
  if (featureArrays.length === 0) return [];

  state.totalScoringAttempts += featureArrays.length;

  const t0 = Date.now();
  const scores = await predictBatch(featureArrays);
  const elapsed = Date.now() - t0;

  state.lastInferenceMs = elapsed;
  state.totalInferenceMs += elapsed;
  state.totalInferenceCalls += 1;

  let successes = 0;
  for (const s of scores) if (s != null) successes++;
  state.totalScored += successes;

  return scores;
}

export function getScorerStatus() {
  const avgInferenceMs =
    state.totalInferenceCalls > 0
      ? Math.round(state.totalInferenceMs / state.totalInferenceCalls)
      : 0;
  return {
    modelLoaded: isModelLoaded(),
    modelVersion: state.modelVersion,
    cloudOnly: true,
    featureCount: FEATURE_COUNT,
    vertexEndpoint: getVertexPredictionEndpoint(),
    totalScoringAttempts: state.totalScoringAttempts,
    totalScored: state.totalScored,
    lastInferenceMs: state.lastInferenceMs,
    avgInferenceMs,
  };
}

// ============================================
// Model version watcher
// ============================================

function startModelWatcher(): void {
  if (state.watcherTimer) return;

  state.watcherTimer = setInterval(async () => {
    try {
      await refreshDeployedModelState();
    } catch (err) {
      logger.warn("MLScorer", `Watcher tick failed: ${(err as Error).message}`);
    }
  }, MODEL_WATCH_INTERVAL_MS);
}

async function refreshDeployedModelState(
  force = false,
): Promise<string | null> {
  const { refreshPermissionLevel } = await import("./deployment-gate");
  await refreshPermissionLevel(force);

  const { db } = await import("@/lib/db/client");
  const { mlModels } = await import("@/lib/db/schema");
  const { eq, desc } = await import("drizzle-orm");

  const [deployed] = await db
    .select({
      version: mlModels.version,
      vertexEndpointName: mlModels.vertexEndpointName,
    })
    .from(mlModels)
    .where(eq(mlModels.status, "deployed"))
    .orderBy(desc(mlModels.deployedAt))
    .limit(1);

  const previousVersion = state.modelVersion;
  const previousEndpoint = state.vertexEndpoint;
  const nextEndpoint = deployed?.vertexEndpointName ?? null;

  state.modelVersion = deployed?.version ?? null;
  setVertexPredictionEndpoint(nextEndpoint);
  state.vertexEndpoint = getVertexPredictionEndpoint();

  if (
    deployed &&
    (force ||
      deployed.version !== previousVersion ||
      state.vertexEndpoint !== previousEndpoint)
  ) {
    logger.info(
      "MLScorer",
      `Loaded deployed model v${deployed.version}: vertexEndpoint=${state.vertexEndpoint ?? "missing"}`,
    );
  }

  return getVertexPredictionEndpoint();
}

export function stopModelWatcher(): void {
  if (state.watcherTimer) {
    clearInterval(state.watcherTimer);
    state.watcherTimer = null;
  }
}
