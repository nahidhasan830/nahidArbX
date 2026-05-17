/**
 * ML Training Status Poller
 *
 * Runs inside the engine process and polls the `ml_models` table for
 * in-progress training runs. When it detects status changes, it emits
 * events through the syncBus so connected SSE clients (the ML Dashboard)
 * get real-time updates.
 *
 * Poll frequency:
 *   - Normal: every 60s (same as scheduler tick)
 *   - Active training: every 5s (fast poll for responsive UI)
 *
 * This module is started by the retraining scheduler and shares its
 * singleton lifecycle.
 */

import { logger } from "../shared/logger";
import { singleton } from "../util/singleton";
import type { MLTrainingUpdate } from "../events/event-bus";

const tag = "MLTrainingPoller";

interface PollerState {
  active: boolean;
  timer: ReturnType<typeof setInterval> | null;
  /** Model IDs we've already seen — tracks phase transitions to avoid duplicate events. */
  knownModels: Map<string, { status: string; lastEmittedPhase: string }>;
  /** Current poll interval in ms. */
  pollIntervalMs: number;
}

const FAST_POLL_MS = 5_000;
const SLOW_POLL_MS = 60_000;
/** If a model stays at 'training' longer than this, auto-fail it.
 *  Pipeline = Cloud Build (~5 min) + Cloud Run Job (~15 min) = ~20 min typical.
 *  45 min gives generous headroom for slow builds or large datasets. */
const STUCK_TRAINING_TIMEOUT_MS = 45 * 60 * 1000; // 45 minutes

const state = singleton<PollerState>("ml:training-poller", () => ({
  active: false,
  timer: null,
  knownModels: new Map(),
  pollIntervalMs: SLOW_POLL_MS,
}));

function mapStatusToPhase(status: string): MLTrainingUpdate["phase"] {
  switch (status) {
    case "training":
      return "training";
    case "validated":
      return "validating";
    case "deployed":
      return "completed";
    case "rejected":
      return "rejected";
    case "failed":
      return "failed";
    default:
      return "training";
  }
}

function phaseMessage(
  phase: MLTrainingUpdate["phase"],
  version: number,
): string {
  switch (phase) {
    case "started":
      return `Model v${version} training job triggered`;
    case "loading":
      return `Loading training data for v${version}`;
    case "training":
      return `LightGBM CPCV training in progress (v${version})`;
    case "validating":
      return `Running deployment gates on v${version}`;
    case "exporting":
      return `Exporting ONNX model v${version}`;
    case "completed":
      return `Model v${version} deployed successfully`;
    case "failed":
      return `Model v${version} training failed`;
    case "rejected":
      return `Model v${version} rejected by deployment gate`;
    default:
      return `Model v${version} — ${phase}`;
  }
}

async function pollTrainingStatus(): Promise<void> {
  try {
    const { db } = await import("../db/client");
    const { mlModels } = await import("../db/schema");
    const { desc, sql } = await import("drizzle-orm");

    // Fetch recent models (last 5 minutes or in-training)
    const recentModels = await db
      .select()
      .from(mlModels)
      .where(
        sql`${mlModels.status} = 'training' OR ${mlModels.createdAt} > now() - interval '5 minutes'`,
      )
      .orderBy(desc(mlModels.createdAt))
      .limit(10);

    const hasActiveTraining = recentModels.some((m) => m.status === "training");

    // ── Stuck-training detection ─────────────────────────────────────
    // If a model has been at 'training' for too long, the Cloud Run Job
    // likely exited without updating the row. Mark it as failed.
    for (const model of recentModels) {
      if (model.status !== "training") continue;
      const startedAt = model.trainingStartedAt
        ? new Date(model.trainingStartedAt).getTime()
        : model.createdAt
          ? new Date(model.createdAt).getTime()
          : Date.now();
      const elapsedMs = Date.now() - startedAt;

      if (elapsedMs > STUCK_TRAINING_TIMEOUT_MS) {
        logger.warn(
          tag,
          `Model v${model.version} stuck at 'training' for ${Math.round(elapsedMs / 60000)}min — marking as failed`,
        );
        try {
          const { eq } = await import("drizzle-orm");
          await db
            .update(mlModels)
            .set({
              status: "failed",
              rejectionReasons: [
                "Training timed out — Cloud Run Job may have exited without updating the database.",
              ],
              trainingCompletedAt: new Date().toISOString(),
            })
            .where(eq(mlModels.id, model.id));

          // Emit a failed event so the UI updates immediately
          const { syncBus } = await import("../events/event-bus");
          const failedUpdate: MLTrainingUpdate = {
            version: model.version,
            phase: "failed",
            message: `Model v${model.version} training timed out after ${Math.round(elapsedMs / 60000)} minutes`,
            updatedAt: Date.now(),
            modelId: model.id,
            elapsedMs,
          };
          syncBus.emitBus({
            type: "ml:training:update",
            training: failedUpdate,
          });

          // Update known models so we don't re-process
          state.knownModels.set(model.id, {
            status: "failed",
            lastEmittedPhase: "failed",
          });

          // Notify via Telegram
          void notifyTrainingCompleted(
            {
              ...model,
              status: "failed",
              rejectionReasons: [
                "Training timed out — Cloud Run Job may have exited without updating the database.",
              ],
            },
            elapsedMs,
          );
        } catch (err) {
          logger.warn(
            tag,
            `Failed to auto-fail stuck model: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Adjust polling frequency based on whether training is happening
    const desiredInterval = hasActiveTraining ? FAST_POLL_MS : SLOW_POLL_MS;
    if (desiredInterval !== state.pollIntervalMs && state.active) {
      state.pollIntervalMs = desiredInterval;
      if (state.timer) clearInterval(state.timer);
      state.timer = setInterval(() => {
        void pollTrainingStatus();
      }, desiredInterval);
      logger.info(
        tag,
        `Poll interval adjusted to ${desiredInterval / 1000}s (${hasActiveTraining ? "active training" : "idle"})`,
      );
    }

    // Emit events for models that changed state
    const { syncBus } = await import("../events/event-bus");

    for (const model of recentModels) {
      const known = state.knownModels.get(model.id);
      const currentPhase = mapStatusToPhase(model.status);

      if (!known) {
        // First time seeing this model — emit its current state
        state.knownModels.set(model.id, {
          status: model.status,
          lastEmittedPhase: currentPhase,
        });

        const startedAt = model.trainingStartedAt
          ? new Date(model.trainingStartedAt).getTime()
          : Date.now();
        const elapsedMs = Date.now() - startedAt;

        const update: MLTrainingUpdate = {
          version: model.version,
          phase: currentPhase,
          message: phaseMessage(currentPhase, model.version),
          updatedAt: Date.now(),
          modelId: model.id,
          elapsedMs,
        };

        // Add metrics for completed/rejected models
        if (model.status === "deployed" || model.status === "rejected") {
          update.metrics = {
            aucRoc:
              model.oosAucRoc != null ? Number(model.oosAucRoc) : undefined,
            dsr:
              model.deflatedSharpe != null
                ? Number(model.deflatedSharpe)
                : undefined,
            pbo: model.pbo != null ? Number(model.pbo) : undefined,
            trainingSamples: model.trainingSamples,
            permissionLevel: model.permissionLevel ?? "observe",
            rejectionReasons:
              (model.rejectionReasons as string[] | null) ?? undefined,
          };
        }

        syncBus.emitBus({ type: "ml:training:update", training: update });
        logger.info(tag, `Emitted ${currentPhase} for model v${model.version}`);
        continue;
      }

      // Model already known — check for status transition
      if (known.status !== model.status) {
        known.status = model.status;
        known.lastEmittedPhase = currentPhase;

        const startedAt = model.trainingStartedAt
          ? new Date(model.trainingStartedAt).getTime()
          : Date.now();
        const elapsedMs = Date.now() - startedAt;

        const update: MLTrainingUpdate = {
          version: model.version,
          phase: currentPhase,
          message: phaseMessage(currentPhase, model.version),
          updatedAt: Date.now(),
          modelId: model.id,
          elapsedMs,
        };

        if (model.status === "deployed" || model.status === "rejected") {
          update.metrics = {
            aucRoc:
              model.oosAucRoc != null ? Number(model.oosAucRoc) : undefined,
            dsr:
              model.deflatedSharpe != null
                ? Number(model.deflatedSharpe)
                : undefined,
            pbo: model.pbo != null ? Number(model.pbo) : undefined,
            trainingSamples: model.trainingSamples,
            permissionLevel: model.permissionLevel ?? "observe",
            rejectionReasons:
              (model.rejectionReasons as string[] | null) ?? undefined,
          };
        }

        syncBus.emitBus({ type: "ml:training:update", training: update });
        logger.info(
          tag,
          `Status transition → ${currentPhase} for model v${model.version}`,
        );

        // ── Send Telegram notification for terminal states ────────────
        if (
          model.status === "deployed" ||
          model.status === "rejected" ||
          model.status === "failed"
        ) {
          void notifyTrainingCompleted(model, elapsedMs);
        }
      }
    }

    // Prune old models from the known set (keep only last 20)
    if (state.knownModels.size > 20) {
      const keys = [...state.knownModels.keys()];
      for (let i = 0; i < keys.length - 20; i++) {
        state.knownModels.delete(keys[i]);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `Poll failed: ${msg}`);
  }
}

export function startTrainingPoller(): void {
  if (state.active) return;
  state.active = true;
  state.pollIntervalMs = SLOW_POLL_MS;
  state.timer = setInterval(() => {
    void pollTrainingStatus();
  }, state.pollIntervalMs);
  // Initial poll after a short delay (let DB be ready)
  setTimeout(() => void pollTrainingStatus(), 2_000);
  logger.info(tag, "Started");
}

export function stopTrainingPoller(): void {
  if (!state.active) return;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.active = false;
  logger.info(tag, "Stopped");
}

/**
 * Manually emit a training-started event (called from retrain API
 * and scheduler when a Cloud Run Job is triggered).
 */
export function emitTrainingStarted(modelId: string, version: number): void {
  const update: MLTrainingUpdate = {
    version,
    phase: "started",
    message: phaseMessage("started", version),
    updatedAt: Date.now(),
    modelId,
  };

  state.knownModels.set(modelId, {
    status: "training",
    lastEmittedPhase: "started",
  });

  // Emit through the bus (async import to avoid circular deps at boot)
  void import("../events/event-bus").then(({ syncBus }) => {
    syncBus.emitBus({ type: "ml:training:update", training: update });
  });

  // Switch to fast polling
  if (state.active && state.pollIntervalMs !== FAST_POLL_MS) {
    state.pollIntervalMs = FAST_POLL_MS;
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => {
      void pollTrainingStatus();
    }, FAST_POLL_MS);
    logger.info(tag, "Switched to fast polling (5s) for active training");
  }
}

/**
 * Send Telegram notification when training reaches a terminal state.
 */
async function notifyTrainingCompleted(
  model: {
    id: string;
    version: number;
    status: string;
    trainingSamples: number;
    oosAucRoc: string | number | null;
    deflatedSharpe: string | number | null;
    pbo: string | number | null;
    permissionLevel: string | null;
    rejectionReasons: unknown;
    trainingStartedAt: string | null;
    trainingCompletedAt: string | null;
  },
  elapsedMs: number,
): Promise<void> {
  try {
    const { notify } = await import("../notifier");

    const outcome: "deployed" | "rejected" | "failed" =
      model.status === "deployed"
        ? "deployed"
        : model.status === "rejected"
          ? "rejected"
          : "failed";

    await notify({
      type: "ml:training_completed",
      at: new Date().toISOString(),
      modelId: model.id,
      version: model.version,
      outcome,
      permissionLevel: model.permissionLevel ?? undefined,
      durationMs: elapsedMs,
      trainingSamples: model.trainingSamples,
      aucRoc: model.oosAucRoc != null ? Number(model.oosAucRoc) : undefined,
      dsr:
        model.deflatedSharpe != null ? Number(model.deflatedSharpe) : undefined,
      pbo: model.pbo != null ? Number(model.pbo) : undefined,
      rejectionReasons: Array.isArray(model.rejectionReasons)
        ? (model.rejectionReasons as string[])
        : undefined,
    });
  } catch (err) {
    logger.warn(
      tag,
      `Telegram training notification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
