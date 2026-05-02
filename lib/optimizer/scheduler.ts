/**
 * ML Model Retraining Scheduler
 *
 * Polls `ml_models` and settled bet counts to decide when a new training
 * run should be triggered. When criteria are met, fires a Cloud Run Job
 * that runs the LightGBM training pipeline (services/optimizer/).
 *
 * Pattern mirrors `lib/settle/scheduler.ts`: singleton state, idempotent
 * (HMR-safe), errors logged + swallowed (don't poison the loop).
 *
 * Previously this file was the Optuna-based optimizer scheduler. It was
 * stripped and repurposed for the ML pipeline in Phase 5.
 */

import { logger } from "../shared/logger";
import { singleton } from "../util/singleton";
import { ML_COLD_START_THRESHOLD } from "../shared/constants";
import { processPendingModelNotifications } from "./notifier-tick";

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
 * Check if retraining should be triggered. Criteria:
 * 1. At least ML_COLD_START_THRESHOLD settled bets with features exist
 * 2. No model is currently in 'training' status
 * 3. Either no model exists OR settled bets since last training > 20% of
 *    the last model's training samples
 */
async function shouldRetrain(): Promise<boolean> {
  try {
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

    // Retrain if settled bets grew by 20%+ since last training
    const growth = settledCount - latest.trainingSamples;
    return growth > latest.trainingSamples * 0.2;
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
    // Dynamic import to avoid bundling GCP deps in Next.js
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { JobsClient } = require("@google-cloud/run") as {
      JobsClient: new () => {
        runJob(req: { name: string }): Promise<unknown>;
      };
    };

    const client = new JobsClient();
    const name = `projects/${projectId}/locations/${region}/jobs/${jobName}`;
    await client.runJob({ name });

    state.totalRetrainTriggers += 1;
    logger.info(tag, `Triggered retraining job: ${jobName}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `Failed to trigger retraining: ${msg}`);
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
  // Fire one tick immediately on startup.
  void tick();
}

export function stopModelRetrainingScheduler(): void {
  if (!state.active) return;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.active = false;
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
