/**
 * ML Scorer — ONNX Inference Singleton (Engine-Only)
 *
 * Loads the currently-deployed model (status='deployed') and serves
 * batch scoring. Calibration supports platt_logit, beta, and isotonic
 * methods (parameters persisted by the Python training pipeline in
 * training_report).
 *
 * ⚠ PROCESS ISOLATION: This module must NEVER be imported by Next.js
 * API routes or React Server Components.
 */

import { singleton } from "@/lib/util/singleton";
import { logger } from "@/lib/shared/logger";
import {
  FEATURE_COUNT,
  FEATURE_NAMES_HASH,
  FEATURE_VERSION,
} from "./features";

// ============================================
// Calibration — unified type + helpers
// ============================================

type CalibMethod = "identity" | "platt_logit" | "beta" | "isotonic";

interface ScoreCalibration {
  method: CalibMethod;
  params: Record<string, number | number[]>;
}

function parseCalibration(report: unknown): ScoreCalibration {
  const identity: ScoreCalibration = { method: "identity", params: {} };
  if (!report || typeof report !== "object") return identity;

  const r = report as {
    calibration_method?: unknown;
    calibration_params?: Record<string, unknown>;
  };

  const method = String(r.calibration_method ?? "identity") as string;
  const params = r.calibration_params ?? {};

  switch (method) {
    case "platt_logit": {
      const intercept = Number(params.intercept);
      const slope = Number(params.slope);
      if (!Number.isFinite(intercept) || !Number.isFinite(slope)) return identity;
      return { method: "platt_logit", params: { intercept, slope } };
    }
    case "beta": {
      const a = Number(params.a);
      const b = Number(params.b);
      const c = Number(params.c);
      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c))
        return identity;
      return { method: "beta", params: { a, b, c } };
    }
    case "isotonic": {
      const x = params.x as number[] | undefined;
      const y = params.y as number[] | undefined;
      if (!Array.isArray(x) || !Array.isArray(y) || x.length === 0 || x.length !== y.length)
        return identity;
      return { method: "isotonic", params: { x, y } };
    }
    default:
      return identity;
  }
}

function applyCalibration(rawScore: number, cal: ScoreCalibration): number {
  if (!Number.isFinite(rawScore)) return rawScore;

  switch (cal.method) {
    case "identity":
      return rawScore;

    case "platt_logit": {
      const clipped = Math.min(1 - 1e-6, Math.max(1e-6, rawScore));
      const logit = Math.log(clipped / (1 - clipped));
      const z = Math.min(35, Math.max(-35,
        (cal.params.intercept as number) + (cal.params.slope as number) * logit));
      return 1 / (1 + Math.exp(-z));
    }

    case "beta": {
      const a = cal.params.a as number;
      const b = cal.params.b as number;
      const c = cal.params.c as number;
      const p = Math.min(1 - 1e-6, Math.max(1e-6, rawScore));
      const z = Math.min(35, Math.max(-35,
        a * Math.log(p) - b * Math.log(1 - p) + c));
      return 1 / (1 + Math.exp(-z));
    }

    case "isotonic": {
      const x = cal.params.x as number[];
      const y = cal.params.y as number[];
      // Linear interpolation (piecewise-linear PAV step function)
      let idx = 0;
      for (let i = 0; i < x.length; i++) {
        if (rawScore <= x[i]) { idx = i; break; }
        if (i === x.length - 1) idx = i;
      }
      if (idx === 0) return Math.max(0, Math.min(1, y[0]));
      const lo = x[idx - 1];
      const hi = x[idx];
      const ly = y[idx - 1];
      const hy = y[idx];
      const t = (hi - lo) > 1e-12 ? (rawScore - lo) / (hi - lo) : 0;
      return Math.max(0, Math.min(1, ly + (hy - ly) * Math.max(0, Math.min(1, t))));
    }

    default:
      return rawScore;
  }
}

// ============================================
// State — singleton for HMR safety
// ============================================

interface ScorerState {
  session: import("onnxruntime-node").InferenceSession | null;
  loadAttempted: boolean;
  modelVersion: number | null;
  modelPath: string | null;
  calibration: ScoreCalibration;
  // ── Ensemble (deployed + top-2 validated) ──────────────────────────
  ensembleSessions: Array<{
    session: import("onnxruntime-node").InferenceSession;
    version: number;
    calibration: ScoreCalibration;
  }>;
  watcherTimer: ReturnType<typeof setInterval> | null;
  // Inference stats for diagnostics
  totalScored: number;
  totalInferenceMs: number;
  lastInferenceMs: number;
}

const state = singleton(
  "ml:scorer",
  (): ScorerState => ({
    session: null,
    loadAttempted: false,
    modelVersion: null,
    modelPath: null,
    calibration: { method: "identity", params: {} },
    ensembleSessions: [],
    watcherTimer: null,
    totalScored: 0,
    totalInferenceMs: 0,
    lastInferenceMs: 0,
  }),
);

const MODEL_CACHE_DIR = ".ml-models";
const MODEL_WATCH_INTERVAL_MS = 60_000;

// ============================================
// Model loading
// ============================================

interface ResolvedModel {
  path: string;
  version: number;
  calibration: ScoreCalibration;
}

interface ModelRowData {
  id: string;
  version: number;
  modelArtifactPath: string | null;
  onnxBlob: Buffer | null;
  trainingReport: unknown;
}

async function resolveDeployedModel(): Promise<ResolvedModel | null> {
  try {
    const { db } = await import("@/lib/db/client");
    const { mlModels } = await import("@/lib/db/schema");
    const { eq, desc } = await import("drizzle-orm");
    const fs = await import("fs");
    const path = await import("path");

    const [deployed] = await db
      .select({
        id: mlModels.id,
        version: mlModels.version,
        modelArtifactPath: mlModels.modelArtifactPath,
        onnxBlob: mlModels.onnxBlob,
        trainingReport: mlModels.trainingReport,
      })
      .from(mlModels)
      .where(eq(mlModels.status, "deployed"))
      .orderBy(desc(mlModels.deployedAt))
      .limit(1);

    const row = (deployed as ModelRowData | undefined) ?? null;

    if (!row) return null;
    const calibration = parseCalibration(row.trainingReport);

    const cacheDir = path.resolve(process.cwd(), MODEL_CACHE_DIR);
    const localPath = path.join(cacheDir, `model-v${row.version}.onnx`);

    if (fs.existsSync(localPath)) {
      return { path: localPath, version: row.version, calibration };
    }

    if (row.onnxBlob) {
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      fs.writeFileSync(localPath, row.onnxBlob);
      const sizeKb = Math.round(row.onnxBlob.length / 1024);
      logger.info(
        "MLScorer",
        `Materialised model v${row.version} from DB blob (${sizeKb} KB) → ${localPath}`,
      );
      return { path: localPath, version: row.version, calibration };
    }

    const bucket = process.env.ML_MODEL_BUCKET;
    if (bucket && row.modelArtifactPath) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Storage } = require("@google-cloud/storage") as {
          Storage: new () => {
            bucket(b: string): {
              file(f: string): {
                download(o: { destination: string }): Promise<void>;
              };
            };
          };
        };
        const gcsFile = new Storage().bucket(bucket).file(row.modelArtifactPath);
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        await gcsFile.download({ destination: localPath });
        logger.info("MLScorer", `Downloaded model v${row.version} from GCS → ${localPath}`);
        return { path: localPath, version: row.version, calibration };
      } catch (gcsErr) {
        logger.warn("MLScorer", `GCS download failed for v${row.version}: ${(gcsErr as Error).message}`);
      }
    }

    if (row.modelArtifactPath && fs.existsSync(row.modelArtifactPath)) {
      return { path: row.modelArtifactPath, version: row.version, calibration };
    }

    logger.warn("MLScorer", `Model v${row.version} has no loadable ONNX artifact`);
    return null;
  } catch (err) {
    logger.warn("MLScorer", `Model path resolution failed: ${(err as Error).message}`);
    return null;
  }
}

async function createSession(modelPath: string): Promise<import("onnxruntime-node").InferenceSession> {
  const ort = await import("onnxruntime-node");
  return ort.InferenceSession.create(modelPath, { executionProviders: ["cpu"] });
}

async function loadModel(resolved: ResolvedModel): Promise<boolean> {
  try {
    const newSession = await createSession(resolved.path);

    // Feature contract validation
    const sessionAny = newSession as unknown as Record<string, unknown>;
    const meta = (sessionAny.metadata ?? sessionAny._metadata) as Record<string, string> | undefined;
    if (meta?.feature_version && Number(meta.feature_version) !== FEATURE_VERSION) {
      logger.error("MLScorer", `Feature version mismatch! Model: ${meta.feature_version}, Code: ${FEATURE_VERSION}`);
      return false;
    }
    if (meta?.feature_names_hash && meta.feature_names_hash !== FEATURE_NAMES_HASH) {
      logger.error("MLScorer", `Feature hash mismatch!`);
      return false;
    }

    state.session = newSession;
    state.modelVersion = resolved.version;
    state.modelPath = resolved.path;
    state.calibration = resolved.calibration;

    logger.info("MLScorer", `Model v${resolved.version} loaded successfully`);
    return true;
  } catch (err) {
    logger.warn("MLScorer", `Model load failed: ${(err as Error).message}`);
    return false;
  }
}

// ============================================
// Public API
// ============================================

export function isModelLoaded(): boolean {
  return state.session != null;
}

export async function ensureModel(): Promise<boolean> {
  if (state.loadAttempted) return state.session != null;
  state.loadAttempted = true;

  const resolved = await resolveDeployedModel();
  if (!resolved) {
    logger.info("MLScorer", "No deployed model — using rule-based fallback");
    startModelWatcher();
    return false;
  }

  const loaded = await loadModel(resolved);
  // Load ensemble on startup
  await refreshEnsemble();
  startModelWatcher();
  return loaded;
}

/**
 * Score a batch of feature vectors on the deployed model (averaged with
 * ensemble if multiple validated models are available).
 * Returns P(profitable) for each. null = no model loaded.
 */
export async function scoreBatch(
  featureArrays: number[][],
): Promise<(number | null)[]> {
  if (featureArrays.length === 0) return [];

  // Ensemble scoring: average across deployed + top-2 validated models
  const allSessions = state.ensembleSessions;
  if (allSessions.length > 1) {
    const allResults = await Promise.all(
      allSessions.map((es) =>
        runInference(es.session, es.calibration, featureArrays),
      ),
    );
    return featureArrays.map((_, i) => {
      const scores = allResults
        .map((r) => r[i])
        .filter((s): s is number => s != null);
      if (scores.length === 0) return null;
      return scores.reduce((a, b) => a + b, 0) / scores.length;
    });
  }

  return runInference(state.session, state.calibration, featureArrays);
}

async function runInference(
  session: import("onnxruntime-node").InferenceSession | null,
  calibration: ScoreCalibration,
  featureArrays: number[][],
): Promise<(number | null)[]> {
  if (!session || featureArrays.length === 0) {
    return featureArrays.map(() => null);
  }

  const inferStart = Date.now();

  try {
    const ort = await import("onnxruntime-node");

    const flat = new Float32Array(featureArrays.length * FEATURE_COUNT);
    for (let i = 0; i < featureArrays.length; i++) {
      for (let j = 0; j < FEATURE_COUNT; j++) {
        flat[i * FEATURE_COUNT + j] = featureArrays[i][j] ?? 0;
      }
    }

    const tensor = new ort.Tensor("float32", flat, [featureArrays.length, FEATURE_COUNT]);
    const inputName = session.inputNames[0] ?? "input";
    const results = await session.run({ [inputName]: tensor });

    const probOutputName =
      session.outputNames.find(
        (n) => n.includes("probabilities") || n.includes("output_probability"),
      ) ?? session.outputNames[session.outputNames.length - 1];

    const probs = results[probOutputName]?.data as Float32Array | undefined;

    const inferMs = Date.now() - inferStart;
    state.totalScored += featureArrays.length;
    state.totalInferenceMs += inferMs;
    state.lastInferenceMs = inferMs;

    if (!probs) {
      logger.warn("MLScorer", "No probability output found in ONNX results");
      return featureArrays.map(() => null);
    }

    if (probs.length === featureArrays.length * 2) {
      return Array.from(
        { length: featureArrays.length },
        (_, i) => applyCalibration(probs[i * 2 + 1], calibration),
      );
    } else if (probs.length === featureArrays.length) {
      return Array.from(probs, (v) => applyCalibration(v, calibration));
    } else {
      logger.warn("MLScorer", `Unexpected output shape: ${probs.length}`);
      return featureArrays.map(() => null);
    }
  } catch (err) {
    logger.error("MLScorer", `Inference failed: ${(err as Error).message}`);
    return featureArrays.map(() => null);
  }
}

export function getScorerStatus() {
  return {
    modelLoaded: state.session != null,
    modelVersion: state.modelVersion,
    modelPath: state.modelPath,
    calibration: state.calibration.method,
    ensembleSize: state.ensembleSessions.length,
    ensembleVersions: state.ensembleSessions.map((es) => es.version),
    featureCount: FEATURE_COUNT,
    totalScored: state.totalScored,
    avgInferenceMs:
      state.totalScored > 0
        ? Math.round((state.totalInferenceMs / state.totalScored) * 100) / 100
        : 0,
    lastInferenceMs: state.lastInferenceMs,
  };
}

// ============================================
// Model version watcher
// ============================================

/** Max ensemble members (deployed + N validated models). */
const MAX_ENSEMBLE = 3;

async function resolveEnsembleModels(): Promise<ResolvedModel[]> {
  try {
    const { db } = await import("@/lib/db/client");
    const { mlModels } = await import("@/lib/db/schema");
    const { eq, and, desc, isNotNull } = await import("drizzle-orm");

    const [deployedRow] = await db
      .select({
        id: mlModels.id,
        version: mlModels.version,
        modelArtifactPath: mlModels.modelArtifactPath,
        onnxBlob: mlModels.onnxBlob,
        trainingReport: mlModels.trainingReport,
      })
      .from(mlModels)
      .where(eq(mlModels.status, "deployed"))
      .orderBy(desc(mlModels.deployedAt))
      .limit(1);

    const validatedRows = await db
      .select({
        id: mlModels.id,
        version: mlModels.version,
        modelArtifactPath: mlModels.modelArtifactPath,
        onnxBlob: mlModels.onnxBlob,
        trainingReport: mlModels.trainingReport,
      })
      .from(mlModels)
      .where(
        and(
          eq(mlModels.status, "validated"),
          isNotNull(mlModels.onnxBlob),
        ),
      )
      .orderBy(desc(mlModels.trainingCompletedAt))
      .limit(MAX_ENSEMBLE - 1);

    const candidates =
      deployedRow != null
        ? [deployedRow, ...validatedRows]
        : (validatedRows as ModelRowData[]);

    const results: ResolvedModel[] = [];
    const fs = await import("fs");
    const path = await import("path");
    const cacheDir = path.resolve(process.cwd(), MODEL_CACHE_DIR);

    for (const row of candidates.slice(0, MAX_ENSEMBLE)) {
      const calibration = parseCalibration(row.trainingReport as Record<string, unknown>);
      const localPath = path.join(cacheDir, `model-v${(row as Record<string, unknown>).version}.onnx`);

      if (fs.existsSync(localPath)) {
        results.push({ path: localPath, version: row.version, calibration });
        continue;
      }

      const blob = (row as Record<string, unknown>).onnxBlob as Buffer | null;
      if (blob) {
        if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(localPath, blob);
        results.push({ path: localPath, version: row.version, calibration });
      }
    }

    return results;
  } catch {
    return [];
  }
}

async function refreshEnsemble(): Promise<void> {
  try {
    const members = await resolveEnsembleModels();
    const currentVersions = new Set(state.ensembleSessions.map((es) => es.version));
    const newVersions = new Set(members.map((m) => m.version));

    if (
      currentVersions.size === newVersions.size &&
      [...currentVersions].every((v) => newVersions.has(v))
    ) {
      return;
    }

    const newSessions: ScorerState["ensembleSessions"] = [];
    for (const member of members) {
      try {
        const session = await createSession(member.path);
        newSessions.push({
          session,
          version: member.version,
          calibration: member.calibration,
        });
      } catch (err) {
        logger.warn("MLScorer", `Ensemble member v${member.version} load failed: ${(err as Error).message}`);
      }
    }

    state.ensembleSessions = newSessions;
    logger.info("MLScorer", `Ensemble: ${newSessions.length} models loaded (v${newSessions.map((es) => es.version).join(", v")})`);
  } catch (err) {
    logger.warn("MLScorer", `Ensemble refresh failed: ${(err as Error).message}`);
  }
}

function startModelWatcher(): void {
  if (state.watcherTimer) return;

  state.watcherTimer = setInterval(async () => {
    try {
      const { refreshPermissionLevel } = await import("./deployment-gate");
      await refreshPermissionLevel();

      // Deployed-model reload
      const deployed = await resolveDeployedModel();
      if (deployed && deployed.version !== state.modelVersion) {
        logger.info("MLScorer", `New deployed model v${deployed.version} (was v${state.modelVersion})`);
        const loaded = await loadModel(deployed);
        if (loaded) {
          try {
            const { triggerDetection } = await import("@/lib/background/reactive-detector");
            triggerDetection({ forceRescore: true });
          } catch { /* non-critical */ }
        }
      }

      // ── Ensemble reload ──────────────────────────────────────────────
      await refreshEnsemble();
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
