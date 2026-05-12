/**
 * ML Model Retraining Scheduler
 *
 * Polls `ml_models` and settled bet counts to decide when a new training
 * run should be triggered. When criteria are met, runs Cloud Build to
 * rebuild the Docker image from current source, then executes the
 * Cloud Run Job (services/optimizer/). This guarantees no stale-image
 * failures — the image is always rebuilt before the job runs.
 *
 * Reads configuration from `ml_scheduler_settings` (DB singleton row)
 * so the operator can adjust cadence, thresholds, and enable/disable
 * from the ML Optimizer dashboard without restarting the engine.
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
} from "../shared/constants";
import { FEATURE_NAMES_HASH } from "../ml/features";
import { processPendingModelNotifications } from "./notifier-tick";
import {
  startTrainingPoller,
  stopTrainingPoller,
  emitTrainingStarted,
} from "./training-poller";

const tag = "ModelRetrainingScheduler";
const POLL_INTERVAL_MS = 60_000; // 60s — retraining checks don't need to be frequent

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
 * Load scheduler settings from DB. Returns defaults if row doesn't exist.
 */
async function loadSettings() {
  try {
    const { db } = await import("../db/client");
    const { mlSchedulerSettings } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");

    const [row] = await db
      .select()
      .from(mlSchedulerSettings)
      .where(eq(mlSchedulerSettings.id, "default"))
      .limit(1);

    return (
      row ?? {
        enabled: true,
        cadenceHours: 24,
        minNewSettledExamples: 50,
        minGrowthPct: 20,
        nextRunAt: null,
        lastRunAt: null,
      }
    );
  } catch {
    // DB not ready or table doesn't exist yet — use defaults
    return {
      enabled: true,
      cadenceHours: 24,
      minNewSettledExamples: 50,
      minGrowthPct: 20,
      nextRunAt: null,
      lastRunAt: null,
    };
  }
}

/**
 * Check if retraining should be triggered. Criteria:
 * 1. Scheduler is enabled in settings
 * 2. At least ML_COLD_START_THRESHOLD settled bets with features exist
 * 3. No model is currently in 'training' status
 * 4. Either no model exists OR settled bets since last training > minGrowthPct%
 *    of the last model's training samples
 * 5. If cadence is set, enough time has passed since last run
 */
async function shouldRetrain(): Promise<boolean> {
  try {
    const settings = await loadSettings();

    // Check if scheduler is enabled
    if (!settings.enabled) return false;

    // Check cadence — skip if not enough time has passed
    if (settings.lastRunAt) {
      const lastRun = new Date(settings.lastRunAt).getTime();
      const cadenceMs = settings.cadenceHours * 60 * 60 * 1000;
      if (Date.now() - lastRun < cadenceMs) return false;
    }

    const { db } = await import("../db/client");
    const { mlModels, bets } = await import("../db/schema");
    const { eq, and, isNotNull, sql, desc } = await import("drizzle-orm");

    // Check if any model is currently training
    const [training] = await db
      .select({ id: mlModels.id })
      .from(mlModels)
      .where(eq(mlModels.status, "training"))
      .limit(1);
    if (training) return false;

    // Phase 2: Count available training samples — only labeled, current-version
    // examples from ml_training_examples + uncovered bets. Matches Python loader.
    const { mlTrainingExamples } = await import("../db/schema");

    const [{ examplesCount }] = await db
      .select({ examplesCount: sql<number>`count(*)::int` })
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

    // Phase 2: Coverage check — only labeled, current-version examples
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

    // No deployed model yet — retrain
    if (!latest) return true;

    // Retrain if settled bets grew by minGrowthPct% since last training
    const growthThreshold = settings.minGrowthPct / 100;
    const growth = totalAvailableSamples - latest.trainingSamples;
    return growth > latest.trainingSamples * growthThreshold;
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
  // ── Insert training row + stamp lastRunAt ──────────────────────────
  let modelId: string;
  try {
    const { db } = await import("../db/client");
    const { mlSchedulerSettings, mlModels } = await import("../db/schema");
    const { eq, sql } = await import("drizzle-orm");

    await db
      .update(mlSchedulerSettings)
      .set({ lastRunAt: sql`now()`, lastError: null })
      .where(eq(mlSchedulerSettings.id, "default"));

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
    });

    emitTrainingStarted(modelId, 0);

    // Send Telegram notification for scheduler-triggered training
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
        trigger: "scheduler",
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
        if (line.trim()) logger.info("MLCloudTrain", line.trim());
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) logger.warn("MLCloudTrain", line.trim());
      }
    });

    child.on("exit", async (code) => {
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
    stampError(msg);
  }
}

/** Write error to scheduler settings (non-critical). */
async function stampError(msg: string): Promise<void> {
  try {
    const { db } = await import("../db/client");
    const { mlSchedulerSettings } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    await db
      .update(mlSchedulerSettings)
      .set({ lastError: msg })
      .where(eq(mlSchedulerSettings.id, "default"));
  } catch {
    /* non-critical */
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
  let driftTriggered = false;
  try {
    const {
      evaluateDriftRetrain,
      checkDrift,
      computeDriftDegradation,
      clearDriftDegradation,
      getDriftDegradationStatus,
      checkCalibrationHealth,
    } = await import("../ml/drift-detector");

    driftTriggered = await evaluateDriftRetrain();
    const driftStatus = checkDrift();

    // ── Clear degradation if a new champion was deployed ────────────
    const degradation = getDriftDegradationStatus();
    if (degradation.degraded) {
      try {
        const { db } = await import("../db/client");
        const { mlModels } = await import("../db/schema");
        const { eq, and } = await import("drizzle-orm");

        const [champion] = await db
          .select({ deployedAt: mlModels.deployedAt })
          .from(mlModels)
          .where(
            and(
              eq(mlModels.status, "deployed"),
              eq(mlModels.isChampion, true),
            ),
          )
          .limit(1);

        if (champion?.deployedAt) {
          const deployedMs = new Date(champion.deployedAt).getTime();
          if (deployedMs > degradation.degradedAt) {
            // New champion was deployed after degradation — clear it
            const restored = clearDriftDegradation();
            if (restored) {
              await db
                .update(mlModels)
                .set({ permissionLevel: restored })
                .where(
                  and(
                    eq(mlModels.status, "deployed"),
                    eq(mlModels.isChampion, true),
                  ),
                );
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
        const { eq, and } = await import("drizzle-orm");

        const [champion] = await db
          .select({ permissionLevel: mlModels.permissionLevel })
          .from(mlModels)
          .where(
            and(
              eq(mlModels.status, "deployed"),
              eq(mlModels.isChampion, true),
            ),
          )
          .limit(1);

        const currentLevel = champion?.permissionLevel ?? "shadow";
        if (currentLevel !== "shadow") {
          const newLevel = computeDriftDegradation(currentLevel);
          if (newLevel) {
            await db
              .update(mlModels)
              .set({ permissionLevel: newLevel })
              .where(
                and(
                  eq(mlModels.status, "deployed"),
                  eq(mlModels.isChampion, true),
                ),
              );
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

    if (driftTriggered) {
      logger.info(tag, "Drift detected — forcing retraining check");
    }

    // ── Calibration health check ───────────────────────────────────
    const calHealth = await checkCalibrationHealth();
    if (calHealth.eceExceeded) {
      logger.warn(
        tag,
        `Calibration decay: ECE=${calHealth.ece.toFixed(4)} (threshold=${0.15}). Consider retraining.`,
      );
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
            const { eq, and } = await import("drizzle-orm");
            await db
              .update(mlModels)
              .set({ permissionLevel: "stake_increase" })
              .where(and(eq(mlModels.status, "deployed"), eq(mlModels.isChampion, true)));
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

    // ── A/B test evaluation (champion vs challenger on placed bets) ─
    try {
      const { evaluateABTest, isABTestActive, stopABTest } = await import("../ml/pilot");
      if (isABTestActive()) {
        const abResult = await evaluateABTest();
        if (abResult.ready) {
          if (abResult.promoteChallenger) {
            logger.info(
              tag,
              `A/B test PASSED: challenger ROI=${(abResult.challengerMean * 100).toFixed(2)}% vs champion=${(abResult.championMean * 100).toFixed(2)}%, PSR=${abResult.psr.toFixed(4)}`,
            );
            const { db } = await import("../db/client");
            const { mlModels } = await import("../db/schema");
            const { eq, and } = await import("drizzle-orm");
            const now = new Date().toISOString();
            const challengerVersion = (await import("../ml/pilot")).getABTestStatus().challengerVersion ?? 0;
            await db
              .update(mlModels)
              .set({ status: "retired", isChampion: false, retiredAt: now })
              .where(and(eq(mlModels.status, "deployed"), eq(mlModels.isChampion, true)));
            await db
              .update(mlModels)
              .set({
                status: "deployed",
                isChampion: true,
                championToAt: now,
                deployedAt: now,
                permissionLevel: "shadow",
              })
              .where(eq(mlModels.version, challengerVersion));
            logger.info(tag, `Challenger v${challengerVersion} promoted to champion via A/B test`);
            logger.info(tag, "Challenger promoted to champion via A/B test");
          } else {
            logger.info(tag, `A/B test FAILED: PSR=${abResult.psr.toFixed(4)}`);
          }
          stopABTest();
        }
      }
    } catch { /* non-critical */ }
  } catch (err) {
    logger.warn(tag, `Drift check failed: ${(err as Error).message}`);
  }

  // 3. Check if retraining should be triggered (normal cadence OR drift)
  try {
    if (driftTriggered || (await shouldRetrain())) {
      logger.info(
        tag,
        `Retraining criteria met (drift=${driftTriggered}) — triggering Cloud Build + Run pipeline`,
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
  logger.info(tag, `Started (poll every ${POLL_INTERVAL_MS / 1000}s)`);
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
  };
}
