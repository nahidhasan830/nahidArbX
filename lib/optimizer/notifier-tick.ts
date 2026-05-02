/**
 * ML Model — Telegram notification for newly deployed models.
 *
 * Called from the retraining scheduler tick. Polls `ml_models` for models
 * that just transitioned to `deployed` status and haven't been notified yet.
 *
 * Previously this was the Optuna run-completion notifier. Stripped and
 * repurposed for the ML pipeline in Phase 5.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { mlModels, type MlModelRow } from "../db/schema";
import { notify } from "../notifier";
import { logger } from "../shared/logger";

const tag = "MLModelNotifier";

/**
 * Find newly deployed models that haven't been notified and send a
 * Telegram notification with the model's headline metrics.
 *
 * Idempotency: we stamp `retiredAt` as a notification marker on deployed
 * models. Wait — that's wrong. We need a separate approach since
 * `retiredAt` has semantic meaning. Instead we use `deployedAt IS NOT NULL`
 * and check a time window (deployed within the last 2 minutes and not
 * already notified in this session).
 */

// Track notified model IDs in-memory to prevent duplicates within a session.
const notifiedIds = new Set<string>();

export async function processPendingModelNotifications(): Promise<number> {
  try {
    // Find models deployed within last 5 minutes that we haven't notified
    const deployed = await db
      .select()
      .from(mlModels)
      .where(
        and(
          eq(mlModels.status, "deployed"),
          sql`${mlModels.deployedAt} IS NOT NULL`,
          sql`${mlModels.deployedAt} > now() - interval '5 minutes'`,
        ),
      );

    let sent = 0;
    for (const model of deployed) {
      if (notifiedIds.has(model.id)) continue;
      notifiedIds.add(model.id);

      try {
        await notify({
          type: "system",
          at: new Date().toISOString(),
          severity: "info",
          message: `🤖 ML Model v${model.version} Deployed\n${formatModelNotification(model)}`,
        });
        sent++;
        logger.info(tag, `Sent deployment notification for model v${model.version}`);
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

function formatModelNotification(model: MlModelRow): string {
  const lines: string[] = [];
  lines.push(`Version: ${model.version}`);
  lines.push(`Type: ${model.modelType}`);
  lines.push(`Training samples: ${model.trainingSamples}`);
  lines.push(`Features: ${model.featureCount}`);

  if (model.oosAucRoc != null) lines.push(`AUC-ROC: ${Number(model.oosAucRoc).toFixed(4)}`);
  if (model.deflatedSharpe != null) lines.push(`Deflated Sharpe: ${Number(model.deflatedSharpe).toFixed(4)}`);
  if (model.pbo != null) lines.push(`PBO: ${Number(model.pbo).toFixed(4)}`);
  if (model.calibrationError != null) lines.push(`Calibration Error: ${Number(model.calibrationError).toFixed(6)}`);
  if (model.oosLogLoss != null) lines.push(`Log Loss: ${Number(model.oosLogLoss).toFixed(6)}`);
  if (model.oosRoiMean != null) lines.push(`OOS ROI: ${Number(model.oosRoiMean).toFixed(4)}%`);

  return lines.join("\n");
}
