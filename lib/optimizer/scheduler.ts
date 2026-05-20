/**
 * ML Model Retraining Scheduler
 *
 * Background loop that decides when a new training run should be
 * triggered. Auto-retraining is gated on a single rule: the canonical
 * training corpus has grown by ≥`ML_RETRAIN_GROWTH_STEP` (200 new
 * examples) since the last deployed model. There is no cadence, no
 * enabled toggle, no tunable threshold — manual retraining stays
 * available via `POST /api/ml/retrain`.
 *
 * The same loop also drives drift detection, calibration health checks,
 * pilot/A-B test evaluation, deployed-model notifications, and the
 * training status poller. Those subsystems are NOT scheduling — they
 * react to live state and remain intact.
 *
 * Pattern mirrors `lib/settle/scheduler.ts`: singleton state, idempotent
 * (HMR-safe), errors logged + swallowed (don't poison the loop).
 */

import { logger } from "../shared/logger";
import { singleton } from "../util/singleton";
import {
  ML_COLD_START_THRESHOLD,
  ML_FEATURE_COUNT,
  ML_FEATURE_VERSION,
  ML_RETRAIN_GROWTH_STEP,
} from "../shared/constants";
import { FEATURE_NAMES_HASH } from "../ml/feature-contract";
import { processPendingModelNotifications } from "./notifier-tick";
import {
  startTrainingPoller,
  stopTrainingPoller,
  emitTrainingStarted,
} from "./training-poller";
import {
  progressMessageFromCloudTrainLog,
  writeCloudTrainingProgress,
} from "./cloud-training-progress";

const tag = "ModelRetrainingScheduler";
const POLL_INTERVAL_MS = 60_000; // 60s — auto-retrain readiness checks don't need to be frequent

interface SchedulerState {
  active: boolean;
  timer: ReturnType<typeof setInterval> | null;
  lastTickAt: number | null;
  lastError: string | null;
  totalRetrainTriggers: number;
}

const state = singleton<SchedulerState>("ml:retrain-scheduler", () => ({
  active: false,
  timer: null,
  lastTickAt: null,
  lastError: null,
  totalRetrainTriggers: 0,
}));

/**
 * Check if retraining should be triggered. Criteria:
 *   1. No model is currently in 'training' status.
 *   2. At least `ML_COLD_START_THRESHOLD` qualified training samples exist.
 *   3. Either no model has been deployed yet, OR the qualified sample
 *      count has grown by ≥`ML_RETRAIN_GROWTH_STEP` (200 examples)
 *      since the last deployed model's training set.
 */
async function shouldRetrain(): Promise<boolean> {
  try {
    const { db } = await import("../db/client");
    const { mlModels, bets, mlTrainingExamples } = await import("../db/schema");
    const { eq, and, isNotNull, sql, desc } = await import("drizzle-orm");

    // Block if any model is currently training
    const [training] = await db
      .select({ id: mlModels.id })
      .from(mlModels)
      .where(eq(mlModels.status, "training"))
      .limit(1);
    if (training) return false;

    // Count canonical, current-version labeled training examples.
    // Python dedupes ml_training_examples by source_bet_id, falling back to
    // event/family/atom when no source bet exists. Match that here, otherwise
    // shadow_scored + settled_detected duplicates make the scheduler retrain
    // immediately after every successful deployment.
    const [{ examplesCount }] = await db
      .select({
        examplesCount: sql<number>`count(distinct coalesce(${mlTrainingExamples.sourceBetId}, ${mlTrainingExamples.eventId} || '|' || ${mlTrainingExamples.familyId} || '|' || ${mlTrainingExamples.atomId}))::int`,
      })
      .from(mlTrainingExamples)
      .where(
        and(
          isNotNull(mlTrainingExamples.label),
          sql`${mlTrainingExamples.label} IN ('positive', 'negative')`,
          isNotNull(mlTrainingExamples.features),
          sql`${mlTrainingExamples.featureVersion} = ${ML_FEATURE_VERSION}`,
          sql`array_length(${mlTrainingExamples.features}, 1) = ${ML_FEATURE_COUNT}`,
          sql`(${mlTrainingExamples.features})[2] > 0`,
          sql`(${mlTrainingExamples.features})[2] < 1`,
          sql`(${mlTrainingExamples.features})[4] > 1.01`,
          sql`(${mlTrainingExamples.features})[22] IN (1.0, 2.0, 3.0)`,
        ),
      );

    // Coverage check — qualified bets not yet in the canonical examples table
    const trainedBetIds = await db
      .select({ sourceBetId: mlTrainingExamples.sourceBetId })
      .from(mlTrainingExamples)
      .where(
        and(
          isNotNull(mlTrainingExamples.sourceBetId),
          isNotNull(mlTrainingExamples.label),
          sql`${mlTrainingExamples.label} IN ('positive', 'negative')`,
          sql`${mlTrainingExamples.featureVersion} = ${ML_FEATURE_VERSION}`,
          sql`array_length(${mlTrainingExamples.features}, 1) = ${ML_FEATURE_COUNT}`,
          sql`(${mlTrainingExamples.features})[22] IN (1.0, 2.0, 3.0)`,
        ),
      );

    const trainedIds = new Set(
      trainedBetIds
        .map((r) => r.sourceBetId)
        .filter((id): id is string => id != null),
    );

    const qualifiedBetIds = await db
      .select({ id: bets.id })
      .from(bets)
      .where(
        and(
          sql`${bets.outcome} NOT IN ('pending', 'void')`,
          isNotNull(bets.mlFeatures),
          sql`${bets.mlFeatureVersion} = ${ML_FEATURE_VERSION}`,
          sql`${bets.mlFeatureNamesHash} = ${FEATURE_NAMES_HASH}`,
          sql`array_length(${bets.mlFeatures}, 1) = ${ML_FEATURE_COUNT}`,
          sql`(${bets.mlFeatures})[22] IN (1.0, 2.0, 3.0)`,
          sql`${bets.sharpTrueProb} > 0`,
          sql`${bets.sharpTrueProb} < 1`,
          sql`${bets.softOdds} > 1.01`,
        ),
      );

    const uncoveredCount = qualifiedBetIds.filter(
      (r) => !trainedIds.has(r.id),
    ).length;
    const totalAvailableSamples =
      examplesCount > 0 ? examplesCount : uncoveredCount;

    if (totalAvailableSamples < ML_COLD_START_THRESHOLD) return false;

    // Get latest deployed model
    const [latest] = await db
      .select({
        trainingSamples: mlModels.trainingSamples,
        createdAt: mlModels.createdAt,
      })
      .from(mlModels)
      .where(eq(mlModels.status, "deployed"))
      .orderBy(desc(mlModels.deployedAt))
      .limit(1);

    // No deployed model yet — train as soon as the corpus passes cold start
    if (!latest) return true;

    // Retrain if the corpus has grown by ≥ML_RETRAIN_GROWTH_STEP
    // examples since the last deployed model.
    const growth = totalAvailableSamples - latest.trainingSamples;
    return growth >= ML_RETRAIN_GROWTH_STEP;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `shouldRetrain check failed: ${msg}`);
    return false;
  }
}

/**
 * Trigger Cloud Run training: build fresh image → deploy → execute.
 *
 * Uses scripts/cloud-train.sh which calls Cloud Build to rebuild the
 * Docker image from current source, then runs the Cloud Run Job.
 * This guarantees no stale images — the image is always rebuilt.
 */
async function triggerRetraining(): Promise<void> {
  // ── Insert training row ──────────────────────────────────────────
  let modelId: string;
  try {
    const { db } = await import("../db/client");
    const { mlModels } = await import("../db/schema");
    const { sql } = await import("drizzle-orm");

    const [{ maxVersion }] = await db
      .select({
        maxVersion: sql<number>`COALESCE(MAX(${mlModels.version}), 0)::int`,
      })
      .from(mlModels);

    modelId = `cloud-training-${Date.now()}`;

    // Use version 0 for the training placeholder — the Python job assigns
    // the real version number only on success.
    await db.insert(mlModels).values({
      id: modelId,
      version: 0,
      status: "training",
      modelType: "lightgbm",
      trainingSamples: 0,
      featureCount: ML_FEATURE_COUNT,
      featureVersion: ML_FEATURE_VERSION,
      featureNamesHash: FEATURE_NAMES_HASH,
      trainingStartedAt: new Date().toISOString(),
      trainingStage: "loading",
      progressMessage: "Cloud Build queued",
      lastHeartbeatAt: new Date().toISOString(),
      estimatedTimeRemainingMs: 20 * 60 * 1000,
    });
    void writeCloudTrainingProgress(
      modelId,
      "Cloud Build queued",
      20 * 60 * 1000,
    );

    emitTrainingStarted(modelId, 0);

    // Send Telegram notification for auto-retrain trigger
    try {
      const { desc, eq: eqOp } = await import("drizzle-orm");
      const { getTrainingSampleAccounting } = await import(
        "../ml/training-sample-accounting"
      );
      const { writeMissingSettledExamples } = await import(
        "../ml/training-example-writer"
      );
      await writeMissingSettledExamples(500);
      const accounting = await getTrainingSampleAccounting(db);

      // Fetch previous deployed model for growth comparison
      const [prevModel] = await db
        .select({
          version: mlModels.version,
          trainingSamples: mlModels.trainingSamples,
        })
        .from(mlModels)
        .where(eqOp(mlModels.status, "deployed"))
        .orderBy(desc(mlModels.deployedAt))
        .limit(1);

      const { notify } = await import("../notifier");
      await notify({
        type: "ml:training_started",
        at: new Date().toISOString(),
        modelId,
        version: maxVersion + 1,
        qualifiedBets: accounting.qualifiedBets,
        rawLabeledExamples: accounting.rawLabeledExamples,
        canonicalExamples: accounting.canonicalExamples,
        uncoveredQualifiedBets: accounting.uncoveredQualifiedBets,
        trainerExpectedSamples: accounting.trainerExpectedSamples,
        featureVersion: ML_FEATURE_VERSION,
        featureCount: ML_FEATURE_COUNT,
        trigger: "auto",
        previousModelVersion: prevModel?.version ?? undefined,
        previousModelSamples: prevModel?.trainingSamples ?? undefined,
      });
    } catch {
      /* non-critical — training proceeds regardless */
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `Failed to insert training row: ${msg}`);
    state.lastError = msg;
    return;
  }

  // ── Spawn build → deploy → run pipeline ────────────────────────────
  try {
    const path = await import("path");
    const { spawn, execSync } = await import("child_process");

    const repoRoot = process.cwd();
    const scriptPath = path.join(repoRoot, "scripts/cloud-train.sh");
    let shortSha: string;
    try {
      shortSha = execSync("git rev-parse --short HEAD", { cwd: repoRoot })
        .toString()
        .trim();
    } catch {
      shortSha = `auto-${Date.now().toString(36)}`;
    }

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
        logger.info("MLCloudTrain", trimmed);
        const progress = progressMessageFromCloudTrainLog(trimmed);
        if (progress) {
          void writeCloudTrainingProgress(modelId, progress, 20 * 60 * 1000);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        logger.warn("MLCloudTrain", trimmed);
        const progress = progressMessageFromCloudTrainLog(trimmed);
        if (progress) {
          void writeCloudTrainingProgress(modelId, progress, 20 * 60 * 1000);
        }
      }
    });

    const heartbeat = setInterval(() => {
      void writeCloudTrainingProgress(
        modelId,
        "Cloud Build/Run pipeline still active",
        20 * 60 * 1000,
      );
    }, 15_000);

    child.on("exit", async (code) => {
      clearInterval(heartbeat);
      if (code !== 0 && code !== null) {
        logger.warn(tag, `Cloud training pipeline exited with code ${code}`);
        try {
          const { db } = await import("../db/client");
          const { mlModels } = await import("../db/schema");
          const { eq } = await import("drizzle-orm");
          await db
            .update(mlModels)
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
            .where(eq(mlModels.id, modelId));
        } catch {
          /* best effort */
        }
      } else {
        logger.info(tag, "Cloud training pipeline completed successfully");
      }
    });

    child.unref();
    state.totalRetrainTriggers += 1;
    logger.info(tag, `Started cloud training pipeline: SHA=${shortSha}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `Cloud training failed: ${msg}`);
    state.lastError = msg;
  }
}

async function tick(): Promise<void> {
  state.lastTickAt = Date.now();

  // 1. Check for pending model deployment notifications
  try {
    await processPendingModelNotifications();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `processPendingModelNotifications failed: ${msg}`);
  }

  // 2. Drift detection + automatic permission degradation
  try {
    const {
      checkDrift,
      computeDriftDegradation,
      clearDriftDegradation,
      getDriftDegradationStatus,
    } = await import("../ml/drift-detector");

    const driftStatus = checkDrift();

    // ── Clear degradation if a new model was deployed ───────────────
    const degradation = getDriftDegradationStatus();
    if (degradation.degraded) {
      try {
        const { db } = await import("../db/client");
        const { mlModels } = await import("../db/schema");
        const { eq } = await import("drizzle-orm");

        const [deployed] = await db
          .select({ deployedAt: mlModels.deployedAt })
          .from(mlModels)
          .where(eq(mlModels.status, "deployed"))
          .limit(1);

        if (deployed?.deployedAt) {
          const deployedMs = new Date(deployed.deployedAt).getTime();
          if (deployedMs > degradation.degradedAt) {
            // New model was deployed after degradation — clear it
            const restored = clearDriftDegradation();
            if (restored) {
              await db
                .update(mlModels)
                .set({ permissionLevel: restored })
                .where(eq(mlModels.status, "deployed"));
              logger.info(tag, `Drift degradation cleared — permission restored to ${restored}`);
            }
          }
        }
      } catch {
        // Non-critical
      }
    }

    // ── Degrade permission on drift detection ───────────────────────
    if (driftStatus.driftDetected && !degradation.degraded) {
      try {
        const { db } = await import("../db/client");
        const { mlModels } = await import("../db/schema");
        const { eq } = await import("drizzle-orm");

        const [deployed] = await db
          .select({ permissionLevel: mlModels.permissionLevel })
          .from(mlModels)
          .where(eq(mlModels.status, "deployed"))
          .limit(1);

        const currentLevel = deployed?.permissionLevel ?? "observe";
        if (currentLevel !== "observe") {
          const newLevel = computeDriftDegradation(currentLevel);
          if (newLevel) {
            await db
              .update(mlModels)
              .set({ permissionLevel: newLevel })
              .where(eq(mlModels.status, "deployed"));
            logger.warn(
              tag,
              `Permission degraded ${currentLevel} → ${newLevel} due to concept drift on: ${driftStatus.driftMetrics.join(", ")}`,
            );
          }
        }
      } catch {
        // Non-critical — degradation persists in memory even if DB update fails
      }
    }

    // ── Pilot evaluation (stake_increase promotion) ────────────────
    try {
      const { evaluatePilot, isPilotActive, stopPilot } = await import("../ml/pilot");
      if (isPilotActive()) {
        const pilotResult = await evaluatePilot();
        if (pilotResult.ready) {
          if (pilotResult.shouldPromote) {
            logger.info(
              tag,
              `Pilot PASSED: boost ROI=${(pilotResult.boostMean * 100).toFixed(2)}% vs control=${(pilotResult.controlMean * 100).toFixed(2)}%, PSR=${pilotResult.psr.toFixed(4)}`,
            );
            // Promote to stake_increase
            const { db } = await import("../db/client");
            const { mlModels } = await import("../db/schema");
            const { eq } = await import("drizzle-orm");
            await db
              .update(mlModels)
              .set({ permissionLevel: "stake_increase" })
              .where(eq(mlModels.status, "deployed"));
            logger.info(tag, "stake_increase UNLOCKED — pilot passed");
          } else {
            logger.info(
              tag,
              `Pilot FAILED: boost ROI=${(pilotResult.boostMean * 100).toFixed(2)}% vs control=${(pilotResult.controlMean * 100).toFixed(2)}%, PSR=${pilotResult.psr.toFixed(4)}`,
            );
          }
          stopPilot();
        }
      }
    } catch {
      // Non-critical
    }
  } catch (err) {
    logger.warn(tag, `Drift check failed: ${(err as Error).message}`);
  }

  // 3. Auto-retrain check — fires when corpus has grown ≥ML_RETRAIN_GROWTH_STEP
  //    examples since last deployed model. Drift detection only degrades permission (no retrain trigger).
  try {
    if (await shouldRetrain()) {
      logger.info(
        tag,
        `Auto-retrain criteria met (growth≥${ML_RETRAIN_GROWTH_STEP} examples) — triggering Cloud Build + Run pipeline`,
      );
      await triggerRetraining();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `Tick error: ${msg}`);
    state.lastError = msg;
  }
}

export function startModelRetrainingScheduler(): void {
  if (state.active) return;
  state.active = true;
  state.timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  logger.info(
    tag,
    `Started — auto-retrain after +${ML_RETRAIN_GROWTH_STEP} new training examples (poll every ${POLL_INTERVAL_MS / 1000}s)`,
  );
  // Start the training status poller for real-time SSE updates
  startTrainingPoller();
  // Fire one tick immediately on startup.
  void tick();
}

export function stopModelRetrainingScheduler(): void {
  if (!state.active) return;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.active = false;
  stopTrainingPoller();
  logger.info(tag, "Stopped");
}

export function isModelRetrainingSchedulerActive(): boolean {
  return state.active;
}

export function getModelRetrainingSchedulerStatus() {
  return {
    active: state.active,
    lastTickAt: state.lastTickAt,
    lastError: state.lastError,
    totalRetrainTriggers: state.totalRetrainTriggers,
    retrainStep: ML_RETRAIN_GROWTH_STEP,
  };
}
