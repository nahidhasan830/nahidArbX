/**
 * Cloud Training Trigger — shared between the manual API route and the
 * auto-retrain scheduler.
 *
 * Owns the full lifecycle of starting a Cloud Build + Cloud Run Job
 * training pipeline:
 *
 *   1. Guard against duplicate `training` rows in `ml_models`.
 *   2. Resolve next version + insert a `version=0 status=training` placeholder.
 *   3. Reconcile missing settled examples + read current accounting.
 *   4. Resolve a git short-SHA for image tagging + audit.
 *   5. Spawn `scripts/cloud-train.sh` detached, with stdout/stderr piped
 *      into the progress writer.
 *   6. Run a 15s heartbeat alongside the child.
 *   7. Mark the row as `failed` on non-zero exit.
 *   8. Send Telegram notification (best-effort, time-boxed).
 *
 * Both entry points (`POST /api/ml/retrain` and the scheduler tick)
 * must call this helper rather than re-implementing the flow.
 */

import { spawn, execSync } from "child_process";
import path from "path";
import { logger } from "@/lib/shared/logger";
import { ML_FEATURE_COUNT, ML_FEATURE_VERSION } from "@/lib/shared/constants";
import { FEATURE_NAMES_HASH } from "@/lib/ml/feature-contract";
import {
  progressMessageFromCloudTrainLog,
  writeCloudTrainingProgress,
} from "@/lib/optimizer/cloud-training-progress";

const tag = "MLCloudTrain";
const HEARTBEAT_INTERVAL_MS = 15_000;
const TRAINING_ESTIMATE_MS = 20 * 60 * 1000;
const NOTIFY_TIMEOUT_MS = 10_000;

export type TrainingTrigger = "manual" | "auto";

export interface TriggerCloudTrainingOptions {
  /** "manual" from API, "auto" from scheduler. Used in Telegram notify and logs. */
  trigger: TrainingTrigger;
  /** Optional callback fired exactly once after the child process is spawned. */
  onSpawned?: () => void;
}

export type TriggerCloudTrainingResult =
  | { ok: true; modelId: string; placeholderVersion: number }
  | { ok: false; reason: "already_running" | "insert_failed"; message: string };

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function triggerCloudTraining(
  opts: TriggerCloudTrainingOptions,
): Promise<TriggerCloudTrainingResult> {
  const { db } = await import("@/lib/db/client");
  const { mlModels } = await import("@/lib/db/schema");
  const { sql, eq, desc } = await import("drizzle-orm");

  // ── 1. Guard against duplicate training runs ─────────────────────────
  const [existing] = await db
    .select({ id: mlModels.id })
    .from(mlModels)
    .where(eq(mlModels.status, "training"))
    .limit(1);

  if (existing) {
    return {
      ok: false,
      reason: "already_running",
      message:
        "A training run is already in progress. Wait for it to complete or check the dashboard.",
    };
  }

  // ── 2. Resolve next version + insert placeholder ─────────────────────
  const [{ maxVersion }] = await db
    .select({
      maxVersion: sql<number>`COALESCE(MAX(${mlModels.version}), 0)::int`,
    })
    .from(mlModels);
  const placeholderVersion = maxVersion + 1;

  const modelId = `cloud-training-${Date.now()}`;
  const nowIso = new Date().toISOString();

  try {
    // Use version 0 for the training placeholder — the Python job assigns
    // the real version number only on success. This prevents failed
    // attempts from wasting version numbers.
    await db.insert(mlModels).values({
      id: modelId,
      version: 0,
      status: "training",
      modelType: "lightgbm",
      trainingSamples: 0,
      featureCount: ML_FEATURE_COUNT,
      featureVersion: ML_FEATURE_VERSION,
      featureNamesHash: FEATURE_NAMES_HASH,
      trainingStartedAt: nowIso,
      trainingStage: "loading",
      progressMessage: "Cloud Build queued",
      lastHeartbeatAt: nowIso,
      estimatedTimeRemainingMs: TRAINING_ESTIMATE_MS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `Failed to insert training row: ${msg}`);
    return { ok: false, reason: "insert_failed", message: msg };
  }

  void writeCloudTrainingProgress(
    modelId,
    "Cloud Build queued",
    TRAINING_ESTIMATE_MS,
  );

  // ── 3. Reconcile + read current accounting (used in notification) ────
  const { reconcileMissingSettledExamples } = await import(
    "@/lib/ml/training-example-writer"
  );
  const { getCurrentCorpusAccounting } = await import(
    "@/lib/ml/training-sample-accounting"
  );
  await reconcileMissingSettledExamples(500);
  const accounting = await getCurrentCorpusAccounting(db);

  // ── 4. Resolve git SHA ───────────────────────────────────────────────
  const repoRoot = process.cwd();
  let shortSha: string;
  try {
    shortSha = execSync("git rev-parse --short HEAD", { cwd: repoRoot })
      .toString()
      .trim();
  } catch {
    shortSha = `${opts.trigger}-${Date.now().toString(36)}`;
  }

  // ── 5. Spawn the build → deploy → run pipeline ───────────────────────
  const scriptPath = path.join(repoRoot, "scripts/cloud-train.sh");
  const child = spawn("bash", [scriptPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SHORT_SHA: shortSha,
      EXPECTED_FEATURE_VERSION: String(ML_FEATURE_VERSION),
      TRAINING_MODEL_ID: modelId,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  child.stdout.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      logger.info(tag, trimmed);
      const progress = progressMessageFromCloudTrainLog(trimmed);
      if (progress) {
        void writeCloudTrainingProgress(
          modelId,
          progress,
          TRAINING_ESTIMATE_MS,
        );
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      logger.warn(tag, trimmed);
      const progress = progressMessageFromCloudTrainLog(trimmed);
      if (progress) {
        void writeCloudTrainingProgress(
          modelId,
          progress,
          TRAINING_ESTIMATE_MS,
        );
      }
    }
  });

  // ── 6. Heartbeat while the pipeline runs ─────────────────────────────
  const heartbeat = setInterval(() => {
    void writeCloudTrainingProgress(
      modelId,
      "Cloud Build/Run pipeline still active",
      TRAINING_ESTIMATE_MS,
    );
  }, HEARTBEAT_INTERVAL_MS);

  // ── 7. Mark row failed on non-zero exit ──────────────────────────────
  child.on("exit", async (code) => {
    clearInterval(heartbeat);
    if (code !== 0 && code !== null) {
      logger.warn(tag, `Pipeline exited with code ${code}`);
      try {
        const { db: d } = await import("@/lib/db/client");
        const { mlModels: m } = await import("@/lib/db/schema");
        const { eq: eqOp } = await import("drizzle-orm");
        await d
          .update(m)
          .set({
            status: "failed",
            rejectionReasons: [
              `Cloud Build + Run pipeline failed (exit code ${code})`,
            ],
            trainingStage: "failed",
            progressMessage: `Cloud Build + Run pipeline failed (exit code ${code})`,
            lastHeartbeatAt: new Date().toISOString(),
            estimatedTimeRemainingMs: 0,
            trainingCompletedAt: new Date().toISOString(),
          })
          .where(eqOp(m.id, modelId));
      } catch {
        /* best effort */
      }
    } else if (code === 0) {
      logger.info(tag, "Cloud training pipeline completed successfully");
    }
  });

  child.unref();
  opts.onSpawned?.();
  logger.info(
    tag,
    `Started cloud training (trigger=${opts.trigger}): SHA=${shortSha}`,
  );

  // ── 8. Telegram notification (best-effort, time-boxed) ───────────────
  void withTimeout(
    (async () => {
      const [prevModel] = await db
        .select({
          version: mlModels.version,
          trainingSamples: mlModels.trainingSamples,
        })
        .from(mlModels)
        .where(eq(mlModels.status, "deployed"))
        .orderBy(desc(mlModels.deployedAt))
        .limit(1);

      const { notify } = await import("@/lib/notifier");
      await notify({
        type: "ml:training_started",
        at: new Date().toISOString(),
        modelId,
        version: placeholderVersion,
        qualifiedBets: accounting.qualifiedBets,
        rawLabeledExamples: accounting.rawLabeledExamples,
        canonicalExamples: accounting.canonicalExamples,
        uncoveredQualifiedBets: accounting.uncoveredQualifiedBets,
        trainerExpectedSamples: accounting.trainerExpectedSamples,
        featureVersion: ML_FEATURE_VERSION,
        featureCount: ML_FEATURE_COUNT,
        trigger: opts.trigger,
        gitSha: shortSha,
        previousModelVersion: prevModel?.version ?? undefined,
        previousModelSamples: prevModel?.trainingSamples ?? undefined,
      });
    })(),
    NOTIFY_TIMEOUT_MS,
    "Telegram ML training notification",
  ).catch((notifyErr) => {
    logger.warn(
      tag,
      `Telegram notification failed: ${
        notifyErr instanceof Error ? notifyErr.message : String(notifyErr)
      }`,
    );
  });

  return { ok: true, modelId, placeholderVersion };
}
