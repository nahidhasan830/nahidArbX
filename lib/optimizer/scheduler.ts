
import { logger } from "../shared/logger";
import { singleton } from "../util/singleton";
import {
  ML_COLD_START_THRESHOLD,
  ML_RETRAIN_GROWTH_STEP,
} from "../shared/constants";
import { processPendingModelNotifications } from "./notifier-tick";
import { failStaleTrainingRuns } from "./training-watchdog";

const tag = "ModelRetrainingScheduler";
const POLL_INTERVAL_MS = 60_000;

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

export interface RetrainDecisionInputs {
  inTrainingCount: number;
  totalAvailableSamples: number;
  coldStartThreshold: number;
  growthStep: number;
  currentFeatureNamesHash: string;
  deployedModel: { trainingSamples: number } | null;
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

export function decideRetrain(input: RetrainDecisionInputs): RetrainDecision {
  if (input.inTrainingCount > 0) {
    return { should: false, reason: "training_in_progress" };
  }

  if (input.totalAvailableSamples < input.coldStartThreshold) {
    return { should: false, reason: "below_cold_start" };
  }

  const last = input.lastTerminalNonDeployed;
  if (last && last.featureNamesHash === input.currentFeatureNamesHash) {
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

    const { getCurrentCorpusAccounting } =
      await import("../ml/training-sample-accounting");
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

  try {
    await failStaleTrainingRuns();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `training watchdog failed: ${msg}`);
  }

  try {
    await processPendingModelNotifications();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `processPendingModelNotifications failed: ${msg}`);
  }

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
            }
          }
        }
      }

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
            }
          }
        }
      }

      try {
        const { evaluatePilot, isPilotActive, stopPilot } =
          await import("../ml/pilot");
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
      }
    } catch (err) {
      logger.warn(tag, `Drift check failed: ${(err as Error).message}`);
    }
  }

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
