import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "../db/client";
import { mlModels } from "../db/schema";
import { logger } from "../shared/logger";

const tag = "MLCloudTrain";

export async function writeCloudTrainingProgress(
  modelId: string,
  message: string,
  estimatedTimeRemainingMs = 0,
): Promise<void> {
  try {
    await db
      .update(mlModels)
      .set({
        trainingStage: "loading",
        progressMessage: message,
        lastHeartbeatAt: new Date().toISOString(),
        estimatedTimeRemainingMs,
      })
      .where(
        and(
          eq(mlModels.id, modelId),
          eq(mlModels.status, "training"),
          or(isNull(mlModels.trainingStage), eq(mlModels.trainingStage, "loading")),
        ),
      );
  } catch (err) {
    logger.warn(
      tag,
      `Failed to write launcher progress: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function progressMessageFromCloudTrainLog(line: string): string | null {
  if (line.includes("Step 1/2")) return "Building Cloud Run training image";
  if (line.includes("Step 2/2")) return "Starting Cloud Run training job";
  if (line.includes("Watching execution")) {
    return "Cloud Run training job started";
  }
  if (line.includes("Status: Starting")) return "Cloud Run execution starting";
  if (line.includes("Status: Running")) return "Cloud Run training job running";
  if (line.includes("Status: Succeeded")) {
    return "Cloud training pipeline complete";
  }
  if (line.includes("Status: Failed")) return "Cloud training pipeline failed";
  return null;
}
