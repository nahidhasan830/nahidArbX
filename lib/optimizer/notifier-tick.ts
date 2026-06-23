
import { and, eq, isNull, sql, or } from "drizzle-orm";
import { db } from "../db/client";
import { mlModels } from "../db/schema";
import { notify } from "../notifier";
import { logger } from "../shared/logger";

const tag = "MLModelNotifier";

export async function processPendingModelNotifications(): Promise<number> {
  try {
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
          or(sql`${mlModels.version} > 0`, eq(mlModels.status, "failed")),
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
