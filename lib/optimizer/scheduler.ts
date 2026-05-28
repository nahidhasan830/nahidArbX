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
  ML_RETRAIN_GROWTH_STEP,
} from "../shared/constants";
import { processPendingModelNotifications } from "./notifier-tick";
import { failStaleTrainingRuns } from "./training-watchdog";

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
/**
 * Inputs the retrain decision considers. Pure data — no DB or imports.
 * Exposed so the decision logic can be unit-tested without mocking the DB.
 */
export interface RetrainDecisionInputs {
  /** Count of `ml_models` rows currently in `status = 'training'`. */
  inTrainingCount: number;
  /** Trainer-expected sample count from `getCurrentCorpusAccounting`. */
  totalAvailableSamples: number;
  /** ML_COLD_START_THRESHOLD constant — minimum samples before any training. */
  coldStartThreshold: number;
  /** ML_RETRAIN_GROWTH_STEP — required growth since last deploy. */
  growthStep: number;
  /** Current feature contract hash. Used as the second axis of the
   *  identical-inputs guard so a code change automatically un-blocks. */
  currentFeatureNamesHash: string;
  /** Latest `ml_models` row at status='deployed', or null. */
  deployedModel: { trainingSamples: number } | null;
  /** Most recent terminal-non-deployed `ml_models` row (rejected or failed),
   *  ordered by `created_at DESC`. Null when no such row exists. */
  lastTerminalNonDeployed: {
    status: "rejected" | "failed";
    trainingSamples: number;
    featureNamesHash: string | null;
    rejectionReasons: string[] | null;
  } | null;
}

export type RetrainDecision =
  | { should: true; reason: "cold_start_first_train" | "growth_step_reached" }
  | {
      should: false;
      reason:
        | "training_in_progress"
        | "below_cold_start"
        | "identical_inputs_would_repeat_outcome"
        | "terminal_growth_below_step"
        | "growth_below_step";
    };

/**
 * Decide whether the auto-retrain scheduler should fire a new training run.
 *
 * Pure function. Encodes four guards in priority order:
 *
 *   1. A run is already in progress → wait.
 *   2. Corpus is below cold-start → wait.
 *   3. The most recent terminal-non-deployed run used the same feature
 *      contract and the corpus has not grown by a full retrain step since
 *      then → wait. Tiny sample increments after a rejection usually
 *      resubmit the same candidate.
 *   4. No deployed model and corpus is above cold-start → train.
 *   5. Otherwise: train iff growth since last deploy ≥ growthStep.
 */
export function decideRetrain(
  input: RetrainDecisionInputs,
): RetrainDecision {
  if (input.inTrainingCount > 0) {
    return { should: false, reason: "training_in_progress" };
  }

  if (input.totalAvailableSamples < input.coldStartThreshold) {
    return { should: false, reason: "below_cold_start" };
  }

  // Terminal-inputs guard. If the most recent rejected/failed run used the
  // same feature contract, wait for a full retrain step before auto-retrying.
  // Manual retrain can still bypass this after an operator fixes config or
  // infrastructure, and feature contract changes automatically unblock code
  // fixes.
  const last = input.lastTerminalNonDeployed;
  if (
    last &&
    last.featureNamesHash === input.currentFeatureNamesHash
  ) {
    const growthSinceTerminal =
      input.totalAvailableSamples - last.trainingSamples;
    if (growthSinceTerminal === 0) {
      return { should: false, reason: "identical_inputs_would_repeat_outcome" };
    }
    if (growthSinceTerminal < input.growthStep) {
      return { should: false, reason: "terminal_growth_below_step" };
    }
  }

  if (!input.deployedModel) {
    return { should: true, reason: "cold_start_first_train" };
  }

  const growth =
    input.totalAvailableSamples - input.deployedModel.trainingSamples;
  if (growth >= input.growthStep) {
    return { should: true, reason: "growth_step_reached" };
  }

  return { should: false, reason: "growth_below_step" };
}

/**
 * Check if retraining should be triggered. Wraps `decideRetrain` with the
 * DB lookups required to populate its inputs.
 */
async function shouldRetrain(): Promise<boolean> {
  try {
    const { db } = await import("../db/client");
    const { mlModels } = await import("../db/schema");
    const { eq, desc, inArray } = await import("drizzle-orm");
    const { FEATURE_NAMES_HASH } = await import("../ml/feature-contract");

    const [trainingRow] = await db
      .select({ id: mlModels.id })
      .from(mlModels)
      .where(eq(mlModels.status, "training"))
      .limit(1);

    const { getCurrentCorpusAccounting } = await import(
      "../ml/training-sample-accounting"
    );
    const accounting = await getCurrentCorpusAccounting(db);
    const totalAvailableSamples = accounting.trainerExpectedSamples;

    const [deployed] = await db
      .select({ trainingSamples: mlModels.trainingSamples })
      .from(mlModels)
      .where(eq(mlModels.status, "deployed"))
      .orderBy(desc(mlModels.deployedAt))
      .limit(1);

    const [lastTerminal] = await db
      .select({
        status: mlModels.status,
        trainingSamples: mlModels.trainingSamples,
        featureNamesHash: mlModels.featureNamesHash,
        rejectionReasons: mlModels.rejectionReasons,
      })
      .from(mlModels)
      .where(inArray(mlModels.status, ["rejected", "failed"]))
      .orderBy(desc(mlModels.createdAt))
      .limit(1);

    let lastTerminalNonDeployed: RetrainDecisionInputs["lastTerminalNonDeployed"] =
      null;
    if (
      lastTerminal &&
      (lastTerminal.status === "rejected" || lastTerminal.status === "failed")
    ) {
      const terminalStatus: "rejected" | "failed" = lastTerminal.status;
      lastTerminalNonDeployed = {
        status: terminalStatus,
        trainingSamples: lastTerminal.trainingSamples,
        featureNamesHash: lastTerminal.featureNamesHash,
        rejectionReasons: lastTerminal.rejectionReasons,
      };
    }

    const decision = decideRetrain({
      inTrainingCount: trainingRow ? 1 : 0,
      totalAvailableSamples,
      coldStartThreshold: ML_COLD_START_THRESHOLD,
      growthStep: ML_RETRAIN_GROWTH_STEP,
      currentFeatureNamesHash: FEATURE_NAMES_HASH,
      deployedModel: deployed ?? null,
      lastTerminalNonDeployed,
    });

    // Diagnostic logging — silence the noisy "training in progress" + "growth
    // below step" cases since they fire on most ticks. Surface the new guard
    // and the ready-to-train signal.
    if (decision.should) {
      logger.info(tag, `shouldRetrain → fire (${decision.reason})`);
    } else if (
      decision.reason === "identical_inputs_would_repeat_outcome" ||
      decision.reason === "terminal_growth_below_step"
    ) {
      logger.info(
        tag,
        `shouldRetrain → skip (${decision.reason}: last run failed/rejected on same feature contract — wait for ${ML_RETRAIN_GROWTH_STEP} new samples, feature-contract change, or manual retry)`,
      );
    }

    return decision.should;
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
/**
 * Trigger Cloud Run training: build fresh image → deploy → execute.
 *
 * Delegates to the shared `triggerCloudTraining` helper in
 * `lib/optimizer/cloud-training.ts` so the manual API route and this
 * scheduler tick share one audited implementation.
 */
async function triggerRetraining(): Promise<void> {
  const { triggerCloudTraining } = await import("./cloud-training");
  const result = await triggerCloudTraining({
    trigger: "auto",
    onSpawned: () => {
      state.totalRetrainTriggers += 1;
    },
  });
  if (!result.ok) {
    state.lastError = result.message;
    if (result.reason !== "already_running") {
      logger.warn(tag, `Cloud training failed: ${result.message}`);
    }
  }
}

async function tick(): Promise<void> {
  state.lastTickAt = Date.now();

  // 1. Repair stale training placeholders before scheduling decisions.
  try {
    await failStaleTrainingRuns();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `training watchdog failed: ${msg}`);
  }

  // 2. Check for pending model deployment notifications
  try {
    await processPendingModelNotifications();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `processPendingModelNotifications failed: ${msg}`);
  }

  // 3. Drift detection + pilot evaluation. Both subsystems only make sense
  //    when a model is actually deployed. Cold-start systems with no
  //    deployed model fall through to the auto-retrain check below.
  let deployedModel: {
    deployedAt: string | null;
    permissionLevel: string | null;
  } | null = null;
  try {
    const { db } = await import("../db/client");
    const { mlModels } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const [row] = await db
      .select({
        deployedAt: mlModels.deployedAt,
        permissionLevel: mlModels.permissionLevel,
      })
      .from(mlModels)
      .where(eq(mlModels.status, "deployed"))
      .limit(1);
    deployedModel = row ?? null;
  } catch {
    // Non-critical — fall through to auto-retrain
  }

  if (deployedModel) {
    try {
      const {
        checkDrift,
        computeDriftDegradation,
        clearDriftDegradation,
        getDriftDegradationStatus,
      } = await import("../ml/drift-detector");

      const driftStatus = checkDrift();
      const degradation = getDriftDegradationStatus();

      // ── Clear degradation if a new model was deployed ───────────────
      if (degradation.degraded && deployedModel.deployedAt) {
        const deployedMs = new Date(deployedModel.deployedAt).getTime();
        if (deployedMs > degradation.degradedAt) {
          const restored = clearDriftDegradation();
          if (restored) {
            try {
              const { db } = await import("../db/client");
              const { mlModels } = await import("../db/schema");
              const { eq } = await import("drizzle-orm");
              await db
                .update(mlModels)
                .set({ permissionLevel: restored })
                .where(eq(mlModels.status, "deployed"));
              logger.info(
                tag,
                `Drift degradation cleared — permission restored to ${restored}`,
              );
            } catch {
              // Non-critical
            }
          }
        }
      }

      // ── Degrade permission on drift detection ───────────────────────
      if (driftStatus.driftDetected && !degradation.degraded) {
        const currentLevel = deployedModel.permissionLevel ?? "observe";
        if (currentLevel !== "observe") {
          const newLevel = computeDriftDegradation(currentLevel);
          if (newLevel) {
            try {
              const { db } = await import("../db/client");
              const { mlModels } = await import("../db/schema");
              const { eq } = await import("drizzle-orm");
              await db
                .update(mlModels)
                .set({ permissionLevel: newLevel })
                .where(eq(mlModels.status, "deployed"));
              logger.warn(
                tag,
                `Permission degraded ${currentLevel} → ${newLevel} due to concept drift on: ${driftStatus.driftMetrics.join(", ")}`,
              );
            } catch {
              // Non-critical — degradation persists in memory even if DB update fails
            }
          }
        }
      }

      // ── Pilot evaluation (stake_increase promotion) ────────────────
      try {
        const { evaluatePilot, isPilotActive, stopPilot } = await import(
          "../ml/pilot"
        );
        if (isPilotActive()) {
          const pilotResult = await evaluatePilot();
          if (pilotResult.ready) {
            if (pilotResult.shouldPromote) {
              logger.info(
                tag,
                `Pilot PASSED: boost ROI=${(pilotResult.boostMean * 100).toFixed(2)}% vs control=${(pilotResult.controlMean * 100).toFixed(2)}%, PSR=${pilotResult.psr.toFixed(4)}`,
              );
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
  }

  // 4. Auto-retrain check — fires when corpus has grown ≥ML_RETRAIN_GROWTH_STEP
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
    retrainStep: ML_RETRAIN_GROWTH_STEP,
  };
}
