/**
 * ML Model — Telegram notification for newly deployed/rejected/failed models.
 *
 * Called from the retraining scheduler tick. Polls `ml_models` for models
 * that just finished (deployed, rejected, or failed) and haven't been notified yet.
 *
 * Notification idempotency is DB-persisted via `ml_models.notified_at`,
 * so restarts cannot duplicate notifications.
 */

import { and, eq, isNull, sql, or } from "drizzle-orm";
import { db } from "../db/client";
import { mlModels } from "../db/schema";
import { notify } from "../notifier";
import { logger } from "../shared/logger";

const tag = "MLModelNotifier";

/**
 * Find newly finished models that haven't been notified and send a
 * Telegram notification with the model's headline metrics.
 *
 * Handles deployed, rejected, and failed outcomes — all use the
 * structured `ml:training_completed` event type for consistent formatting.
 *
 * Idempotency: we stamp `notified_at` on the model row after sending
 * the Telegram notification. This persists across engine restarts.
 */
export async function processPendingModelNotifications(): Promise<number> {
  try {
    // Find finished models (deployed/rejected/failed) that have NOT been notified yet
    const pending = await db
      .select()
      .from(mlModels)
      .where(
        and(
          or(
            eq(mlModels.status, "deployed"),
            eq(mlModels.status, "rejected"),
            eq(mlModels.status, "failed"),
          ),
          isNull(mlModels.notifiedAt),
          // Only notify real models (version > 0 = Python assigned a real version)
          // or failed placeholder models (version 0 but status = failed)
          or(
            sql`${mlModels.version} > 0`,
            eq(mlModels.status, "failed"),
          ),
        ),
      );

    let sent = 0;
    for (const model of pending) {
      try {
        const outcome =
          model.status === "deployed"
            ? "deployed"
            : model.status === "rejected"
              ? "rejected"
              : "failed";

        const startedAt = model.trainingStartedAt
          ? new Date(model.trainingStartedAt).getTime()
          : null;
        const completedAt = model.trainingCompletedAt
          ? new Date(model.trainingCompletedAt).getTime()
          : null;
        const durationMs =
          startedAt && completedAt ? completedAt - startedAt : 0;

        await notify({
          type: "ml:training_completed",
          at: new Date().toISOString(),
          modelId: model.id,
          version: model.version,
          outcome,
          durationMs,
          trainingSamples: model.trainingSamples,
          aucRoc: model.oosAucRoc != null ? Number(model.oosAucRoc) : undefined,
          dsr:
            model.deflatedSharpe != null
              ? Number(model.deflatedSharpe)
              : undefined,
          pbo: model.pbo != null ? Number(model.pbo) : undefined,
          permissionLevel:
            outcome === "deployed"
              ? (model.permissionLevel ?? undefined)
              : undefined,
          rejectionReasons:
            model.rejectionReasons &&
            (model.rejectionReasons as string[]).length > 0
              ? (model.rejectionReasons as string[])
              : undefined,
        });

        // Stamp notified_at so we never re-notify, even after restart
        await db
          .update(mlModels)
          .set({ notifiedAt: new Date().toISOString() })
          .where(eq(mlModels.id, model.id));

        sent++;
        logger.info(
          tag,
          `Sent ${outcome} notification for model v${model.version}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(tag, `Failed to notify model ${model.id}: ${msg}`);
      }
    }
    return sent;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(tag, `processPendingModelNotifications failed: ${msg}`);
    return 0;
  }
}
