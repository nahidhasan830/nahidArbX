
import { spawn, execSync } from "child_process";
import path from "path";
import { logger } from "@/lib/shared/logger";
import { ML_FEATURE_COUNT, ML_FEATURE_VERSION } from "@/lib/shared/constants";
import { FEATURE_NAMES_HASH } from "@/lib/ml/feature-contract";
import {
  progressMessageFromCloudTrainLog,
  writeCloudTrainingProgress,
} from "@/lib/optimizer/cloud-training-progress";
import {
  markTrainingRunFailed,
  TRAINING_INTERRUPTED_REASON_PREFIX,
} from "@/lib/optimizer/training-watchdog";

const tag = "MLCloudTrain";
const HEARTBEAT_INTERVAL_MS = 15_000;
const TRAINING_ESTIMATE_MS = 20 * 60 * 1000;
const NOTIFY_TIMEOUT_MS = 10_000;

export type TrainingTrigger = "manual" | "auto";

export interface TriggerCloudTrainingOptions {
  trigger: TrainingTrigger;
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

  const { reconcileMissingSettledExamples } =
    await import("@/lib/ml/training-example-writer");
  const { getCurrentCorpusAccounting } =
    await import("@/lib/ml/training-sample-accounting");
  await reconcileMissingSettledExamples(500);
  const accounting = await getCurrentCorpusAccounting(db);

  const [{ maxVersion }] = await db
    .select({
      maxVersion: sql<number>`COALESCE(MAX(${mlModels.version}), 0)::int`,
    })
    .from(mlModels);
  const placeholderVersion = maxVersion + 1;

  const modelId = `cloud-training-${Date.now()}`;
  const nowIso = new Date().toISOString();

  try {
    await db.insert(mlModels).values({
      id: modelId,
      version: 0,
      status: "training",
      modelType: "lightgbm",
      trainingSamples: accounting.trainerExpectedSamples,
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

  const repoRoot = process.cwd();
  let shortSha: string;
  try {
    shortSha = execSync("git rev-parse --short HEAD", { cwd: repoRoot })
      .toString()
      .trim();
  } catch {
    shortSha = `${opts.trigger}-${Date.now().toString(36)}`;
  }

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
  let terminalMarked = false;

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

  const heartbeat = setInterval(() => {
    void writeCloudTrainingProgress(
      modelId,
      "Cloud Build/Run pipeline still active",
      TRAINING_ESTIMATE_MS,
    );
  }, HEARTBEAT_INTERVAL_MS);

  const shutdownSignals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const shutdownHandlers = new Map<
    (typeof shutdownSignals)[number],
    () => void
  >();

  const removeShutdownHandlers = () => {
    for (const [signal, handler] of shutdownHandlers) {
      process.off(signal, handler);
    }
    shutdownHandlers.clear();
  };

  const killChildGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
      }
    }
  };

  const markInterrupted = (signal: NodeJS.Signals) => {
    if (terminalMarked) return;
    terminalMarked = true;
    clearInterval(heartbeat);
    removeShutdownHandlers();
    killChildGroup(signal);
    const reason =
      `${TRAINING_INTERRUPTED_REASON_PREFIX} (${signal}) before the training ` +
      "pipeline wrote a terminal status.";
    void markTrainingRunFailed(modelId, reason, {
      trainingSamples: accounting.trainerExpectedSamples,
    }).catch((err) => {
      logger.warn(
        tag,
        `Failed to mark interrupted training run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };

  for (const signal of shutdownSignals) {
    const handler = () => markInterrupted(signal);
    shutdownHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  child.on("error", (err) => {
    if (terminalMarked) return;
    terminalMarked = true;
    clearInterval(heartbeat);
    removeShutdownHandlers();
    const reason = `Cloud Build + Run pipeline failed to spawn: ${err.message}`;
    logger.warn(tag, reason);
    void markTrainingRunFailed(modelId, reason, {
      trainingSamples: accounting.trainerExpectedSamples,
    });
  });

  child.on("exit", async (code) => {
    if (terminalMarked) return;
    terminalMarked = true;
    clearInterval(heartbeat);
    removeShutdownHandlers();
    if (code !== 0 && code !== null) {
      logger.warn(tag, `Pipeline exited with code ${code}`);
      try {
        const reason = `Cloud Build + Run pipeline failed (exit code ${code})`;
        await markTrainingRunFailed(modelId, reason, {
          trainingSamples: accounting.trainerExpectedSamples,
        });
      } catch {
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
