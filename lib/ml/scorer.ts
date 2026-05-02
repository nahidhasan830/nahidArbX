/**
 * ML Scorer — ONNX Inference Singleton (Engine-Only)
 *
 * Loads a trained LightGBM model (exported as ONNX) and scores batches
 * of feature vectors in real-time. Uses the `singleton()` pattern for
 * HMR safety and lazy-loads the model on first use.
 *
 * ⚠ PROCESS ISOLATION: This module must NEVER be imported by Next.js
 * API routes or React Server Components — the `onnxruntime-node` native
 * binaries would crash webpack. The dual-process architecture guarantees
 * this: scoring runs in `engine.ts` only, Next.js reads scores from the
 * `bets` table or via `engineGet()` proxy.
 *
 * Model lifecycle:
 *   1. On first `ensureModel()`, try local cache → GCS download
 *   2. Every 60s, poll `ml_models WHERE status='deployed'` for version changes
 *   3. On version change, hot-reload the ONNX session
 */

import { singleton } from "@/lib/util/singleton";
import { logger } from "@/lib/shared/logger";
import { FEATURE_NAMES, FEATURE_COUNT } from "./features";

// ============================================
// State — singleton for HMR safety
// ============================================

interface ScorerState {
  session: import("onnxruntime-node").InferenceSession | null;
  loadAttempted: boolean;
  modelVersion: number | null;
  modelPath: string | null;
  watcherTimer: ReturnType<typeof setInterval> | null;
  // Inference stats for diagnostics
  totalScored: number;
  totalInferenceMs: number;
  lastInferenceMs: number;
}

const state = singleton("ml:scorer", (): ScorerState => ({
  session: null,
  loadAttempted: false,
  modelVersion: null,
  modelPath: null,
  watcherTimer: null,
  totalScored: 0,
  totalInferenceMs: 0,
  lastInferenceMs: 0,
}));

/** Local cache directory for ONNX model files. */
const MODEL_CACHE_DIR = ".ml-models";

/** How often to check for new deployed models (ms). */
const MODEL_WATCH_INTERVAL_MS = 60_000;

// ============================================
// Model loading
// ============================================

/**
 * Resolve the path to the latest deployed ONNX model.
 *
 * Priority:
 *   1. Local cache: `.ml-models/model-v{version}.onnx`
 *   2. GCS download (when ML_MODEL_BUCKET is set)
 *   3. DB-registered artifact path
 *
 * Returns null if no model is available.
 */
async function resolveModelPath(): Promise<{ path: string; version: number } | null> {
  try {
    const { db } = await import("@/lib/db/client");
    const { mlModels } = await import("@/lib/db/schema");
    const { eq, desc } = await import("drizzle-orm");
    const fs = await import("fs");
    const path = await import("path");

    // Find the latest deployed model
    const [deployed] = await db
      .select({
        id: mlModels.id,
        version: mlModels.version,
        modelArtifactPath: mlModels.modelArtifactPath,
      })
      .from(mlModels)
      .where(eq(mlModels.status, "deployed"))
      .orderBy(desc(mlModels.deployedAt))
      .limit(1);

    if (!deployed) return null;

    // Check local cache first
    const cacheDir = path.resolve(process.cwd(), MODEL_CACHE_DIR);
    const localPath = path.join(cacheDir, `model-v${deployed.version}.onnx`);

    if (fs.existsSync(localPath)) {
      return { path: localPath, version: deployed.version };
    }

    // Try GCS download if bucket is configured
    // NOTE: @google-cloud/storage is loaded dynamically to avoid webpack
    // tracing in the Next.js build (scorer is engine-only, but Turbopack
    // still traces the import graph). The require() call is invisible to
    // the static analyzer.
    const bucket = process.env.ML_MODEL_BUCKET;
    if (bucket && deployed.modelArtifactPath) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Storage } = require("@google-cloud/storage") as { Storage: new () => { bucket(b: string): { file(f: string): { download(o: { destination: string }): Promise<void> } } } };
        const storage = new Storage();
        const gcsFile = storage.bucket(bucket).file(deployed.modelArtifactPath);

        // Ensure cache directory exists
        if (!fs.existsSync(cacheDir)) {
          fs.mkdirSync(cacheDir, { recursive: true });
        }

        await gcsFile.download({ destination: localPath });
        logger.info("MLScorer", `Downloaded model v${deployed.version} from GCS → ${localPath}`);
        return { path: localPath, version: deployed.version };
      } catch (gcsErr) {
        logger.warn(
          "MLScorer",
          `GCS download failed for v${deployed.version}: ${(gcsErr as Error).message}`,
        );
      }
    }

    // Fall back to the registered artifact path (might be a local path from dev)
    if (deployed.modelArtifactPath && fs.existsSync(deployed.modelArtifactPath)) {
      return { path: deployed.modelArtifactPath, version: deployed.version };
    }

    return null;
  } catch (err) {
    logger.warn("MLScorer", `Model path resolution failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Load (or reload) the ONNX model into the inference session.
 * Validates the feature name contract embedded in model metadata.
 */
async function loadModel(modelPath: string, version: number): Promise<boolean> {
  try {
    const ort = await import("onnxruntime-node");

    const newSession = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
    });

    // Validate feature name contract — fail loud on mismatch.
    // ONNX metadata is exposed differently across onnxruntime versions;
    // we try the most common accessors and fall back gracefully.
    let modelFeatureNames: string | undefined;
    try {
      // onnxruntime-node exposes metadata on the session object
      const sessionAny = newSession as unknown as Record<string, unknown>;
      const meta = (sessionAny.metadata ?? sessionAny._metadata) as Record<string, string> | undefined;
      modelFeatureNames = meta?.feature_names;
    } catch {
      // metadata access not supported in this version — skip validation
    }
    if (modelFeatureNames && modelFeatureNames !== FEATURE_NAMES.join(",")) {
      logger.error(
        "MLScorer",
        `Feature name mismatch! Model: [${modelFeatureNames}], Code: [${FEATURE_NAMES.join(",")}]`,
      );
      return false;
    }

    // Swap the session atomically
    state.session = newSession;
    state.modelVersion = version;
    state.modelPath = modelPath;

    logger.info("MLScorer", `Model v${version} loaded successfully (${modelPath})`);
    return true;
  } catch (err) {
    logger.warn("MLScorer", `Model load failed: ${(err as Error).message}`);
    return false;
  }
}

// ============================================
// Public API
// ============================================

/**
 * Ensure the ONNX model is loaded. Call at boot for warmup.
 * Returns true if a model is active, false if operating in pass-through mode.
 */
export async function ensureModel(): Promise<boolean> {
  if (state.loadAttempted) return state.session != null;
  state.loadAttempted = true;

  const resolved = await resolveModelPath();
  if (!resolved) {
    logger.info("MLScorer", "No deployed model found — using rule-based fallback (pass-through)");
    startModelWatcher();
    return false;
  }

  const loaded = await loadModel(resolved.path, resolved.version);
  startModelWatcher();
  return loaded;
}

/**
 * Score a batch of feature vectors. Returns P(profitable) for each.
 *
 * When no model is loaded, returns 1.0 for all inputs (pass-through mode)
 * so the system behaves identically to pre-ML: every bet passes the gate.
 */
export async function scoreBatch(featureArrays: number[][]): Promise<number[]> {
  if (!state.session || featureArrays.length === 0) {
    return featureArrays.map(() => 1.0); // pass-through
  }

  const inferStart = Date.now();

  try {
    const ort = await import("onnxruntime-node");

    // Flatten 2D array into Float32Array for ONNX tensor
    const flat = new Float32Array(featureArrays.length * FEATURE_COUNT);
    for (let i = 0; i < featureArrays.length; i++) {
      for (let j = 0; j < FEATURE_COUNT; j++) {
        flat[i * FEATURE_COUNT + j] = featureArrays[i][j] ?? 0;
      }
    }

    const tensor = new ort.Tensor("float32", flat, [featureArrays.length, FEATURE_COUNT]);

    // LightGBM ONNX models typically name their input "input"
    // but the name can vary — use the first input name from the session
    const inputName = state.session.inputNames[0] ?? "input";
    const results = await state.session.run({ [inputName]: tensor });

    // LightGBM ONNX outputs probabilities as [n, 2] — column 1 is P(positive)
    const outputName = state.session.outputNames.find(
      (n) => n.includes("probabilities") || n.includes("output_probability"),
    ) ?? state.session.outputNames[state.session.outputNames.length - 1];

    const probs = results[outputName]?.data as Float32Array | undefined;

    const inferMs = Date.now() - inferStart;
    state.totalScored += featureArrays.length;
    state.totalInferenceMs += inferMs;
    state.lastInferenceMs = inferMs;

    if (!probs) {
      logger.warn("MLScorer", "No probability output found in ONNX results");
      return featureArrays.map(() => 1.0);
    }

    // Extract P(positive) — for [n, 2] shape, it's column 1 (index i*2+1)
    // For [n] shape, it's the value directly
    if (probs.length === featureArrays.length * 2) {
      // [n, 2] layout
      return Array.from({ length: featureArrays.length }, (_, i) => probs[i * 2 + 1]);
    } else if (probs.length === featureArrays.length) {
      // [n] layout
      return Array.from(probs);
    } else {
      logger.warn("MLScorer", `Unexpected output shape: ${probs.length} for ${featureArrays.length} inputs`);
      return featureArrays.map(() => 1.0);
    }
  } catch (err) {
    logger.error("MLScorer", `Inference failed: ${(err as Error).message}`);
    return featureArrays.map(() => 1.0); // fail-open
  }
}

/**
 * Get diagnostic stats for the ML scorer (exposed via engine HTTP API).
 */
export function getScorerStatus() {
  return {
    modelLoaded: state.session != null,
    modelVersion: state.modelVersion,
    modelPath: state.modelPath,
    featureCount: FEATURE_COUNT,
    totalScored: state.totalScored,
    avgInferenceMs:
      state.totalScored > 0
        ? Math.round(state.totalInferenceMs / state.totalScored * 100) / 100
        : 0,
    lastInferenceMs: state.lastInferenceMs,
  };
}

// ============================================
// Model version watcher
// ============================================

/**
 * Start polling for model version changes. If a new deployed model is
 * found, hot-reload the ONNX session without restarting the engine.
 */
function startModelWatcher(): void {
  if (state.watcherTimer) return; // already watching

  state.watcherTimer = setInterval(async () => {
    try {
      const resolved = await resolveModelPath();
      if (!resolved) return;

      // If version changed (or no model was loaded), reload
      if (resolved.version !== state.modelVersion) {
        logger.info(
          "MLScorer",
          `New model version detected: v${resolved.version} (current: v${state.modelVersion ?? "none"})`,
        );
        await loadModel(resolved.path, resolved.version);
      }
    } catch (err) {
      logger.warn("MLScorer", `Model watcher tick failed: ${(err as Error).message}`);
    }
  }, MODEL_WATCH_INTERVAL_MS);
}

/**
 * Stop the model version watcher (called on engine shutdown).
 */
export function stopModelWatcher(): void {
  if (state.watcherTimer) {
    clearInterval(state.watcherTimer);
    state.watcherTimer = null;
  }
}
