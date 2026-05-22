/**
 * ML Scorer — Vertex AI Prediction (Engine-Only)
 *
 * Cloud-managed inference via Vertex AI Prediction endpoint.
 * Replaces local ONNX scoring with managed LightGBM model deployment.
 *
 * Configuration:
 *   VERTEX_PREDICTION_ENDPOINT — endpoint resource name or URL
 *   GCP_PROJECT_ID, GCP_REGION — already configured
 *
 * ⚠ PROCESS ISOLATION: This module must NEVER be imported by Next.js
 * API routes or React Server Components.
 */

import { singleton } from "@/lib/util/singleton";
import { logger } from "@/lib/shared/logger";
import { predictBatch, healthCheck } from "./vertex-prediction-client";

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
  }),
);

const MODEL_WATCH_INTERVAL_MS = 60_000;

// ============================================
// Public API
// ============================================

export function isModelLoaded(): boolean {
  // Vertex AI endpoint is always "loaded" if configured
  return !!process.env.VERTEX_PREDICTION_ENDPOINT;
}

export async function ensureModel(): Promise<boolean> {
  if (state.loadAttempted) return state.modelVersion !== null;
  state.loadAttempted = true;

  const endpointConfigured = !!process.env.VERTEX_PREDICTION_ENDPOINT;
  if (!endpointConfigured) {
    logger.info(
      "MLScorer",
      "VERTEX_PREDICTION_ENDPOINT not configured — scoring returns null (fail-open).",
    );
  } else {
    logger.info("MLScorer", "Vertex AI Prediction endpoint configured");
    // Health check the endpoint
    const healthy = await healthCheck();
    if (healthy) {
      logger.info("MLScorer", "Vertex AI endpoint health check passed");
    } else {
      logger.warn(
        "MLScorer",
        "Vertex AI endpoint health check failed — scoring will return null",
      );
    }
  }

  const { refreshPermissionLevel } = await import("./deployment-gate");
  await refreshPermissionLevel(true);
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
    vertexEndpoint: process.env.VERTEX_PREDICTION_ENDPOINT || null,
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
      const { refreshPermissionLevel } = await import("./deployment-gate");
      await refreshPermissionLevel();

      const { db } = await import("@/lib/db/client");
      const { mlModels } = await import("@/lib/db/schema");
      const { eq, desc } = await import("drizzle-orm");

      const [deployed] = await db
        .select({ version: mlModels.version })
        .from(mlModels)
        .where(eq(mlModels.status, "deployed"))
        .orderBy(desc(mlModels.deployedAt))
        .limit(1);

      if (deployed && deployed.version !== state.modelVersion) {
        state.modelVersion = deployed.version;
        logger.info(
          "MLScorer",
          `New deployed model v${deployed.version} detected`,
        );
      }
    } catch (err) {
      logger.warn("MLScorer", `Watcher tick failed: ${(err as Error).message}`);
    }
  }, MODEL_WATCH_INTERVAL_MS);
}

export function stopModelWatcher(): void {
  if (state.watcherTimer) {
    clearInterval(state.watcherTimer);
    state.watcherTimer = null;
  }
}
