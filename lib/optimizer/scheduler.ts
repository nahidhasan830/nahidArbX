/**
 * ML Model Retraining Scheduler
 *
 * Polls `ml_models` and settled bet counts to decide when a new training
 * run should be triggered. When criteria are met, fires a Cloud Run Job
 * that runs the LightGBM training pipeline (services/optimizer/).
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
import { ML_COLD_START_THRESHOLD, ML_FEATURE_VERSION } from "../shared/constants";
import { processPendingModelNotifications } from "./notifier-tick";
import { startTrainingPoller, stopTrainingPoller, emitTrainingStarted } from "./training-poller";

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

    return row ?? {
      enabled: true,
      cadenceHours: 24,
      minNewSettledExamples: 50,
      minGrowthPct: 20,
      nextRunAt: null,
      lastRunAt: null,
    };
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

    // Count settled bets with ML features
    const [{ count: settledCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(bets)
      .where(
        and(
          sql`${bets.outcome} <> 'pending'`,
          isNotNull(bets.mlFeatures),
        ),
      );
    if (settledCount < ML_COLD_START_THRESHOLD) return false;

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
    const growth = settledCount - latest.trainingSamples;
    return growth > latest.trainingSamples * growthThreshold;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `shouldRetrain check failed: ${msg}`);
    return false;
  }
}

/**
 * Trigger the Cloud Run Job for LightGBM training.
 */
async function triggerRetraining(): Promise<void> {
  const jobName = process.env.OPTIMIZER_JOB_NAME;
  const region = process.env.GCP_REGION;
  const projectId = process.env.GCP_PROJECT_ID;

  if (!jobName || !region || !projectId) {
    logger.warn(tag, "Missing GCP config (OPTIMIZER_JOB_NAME / GCP_REGION / GCP_PROJECT_ID) — skipping retrain");
    return;
  }

  try {
    const runModule = await import("@google-cloud/run");
    const JobsClient = runModule.JobsClient || runModule.default?.JobsClient;

    const client = new JobsClient();
    const name = `projects/${projectId}/locations/${region}/jobs/${jobName}`;
    await client.runJob({
      name,
      overrides: {
        containerOverrides: [{
          env: [{ name: "EXPECTED_FEATURE_VERSION", value: String(ML_FEATURE_VERSION) }],
        }],
      },
    });

    state.totalRetrainTriggers += 1;
    logger.info(tag, `Triggered retraining job: ${jobName}`);

    // Stamp lastRunAt in settings and insert training row
    try {
      const { db } = await import("../db/client");
      const { mlSchedulerSettings, mlModels } = await import("../db/schema");
      const { eq, sql } = await import("drizzle-orm");
      
      await db
        .update(mlSchedulerSettings)
        .set({ lastRunAt: sql`now()`, lastError: null })
        .where(eq(mlSchedulerSettings.id, "default"));
        
      const [{ maxVersion }] = await db
        .select({ maxVersion: sql<number>`COALESCE(MAX(${mlModels.version}), 0)::int` })
        .from(mlModels);
        
      await db.insert(mlModels).values({
        id: `training-${Date.now()}`,
        version: maxVersion + 1,
        status: "training",
        modelType: "lightgbm",
        trainingSamples: 0,
        featureCount: 25,
        featureVersion: 2,
        trainingStartedAt: new Date().toISOString(),
      });

      // Emit real-time training-started event for SSE subscribers
      emitTrainingStarted(`training-${Date.now()}`, maxVersion + 1);
    } catch (e) { logger.warn(tag, "Failed to update db states", e) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `Failed to trigger retraining: ${msg}`);
    state.lastError = msg;

    // Stamp error in settings
    try {
      const { db } = await import("../db/client");
      const { mlSchedulerSettings } = await import("../db/schema");
      const { eq } = await import("drizzle-orm");
      await db
        .update(mlSchedulerSettings)
        .set({ lastError: msg })
        .where(eq(mlSchedulerSettings.id, "default"));
    } catch { /* non-critical */ }
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

  // 2. Check if retraining should be triggered
  try {
    if (await shouldRetrain()) {
      logger.info(tag, "Retraining criteria met — triggering Cloud Run Job");
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
