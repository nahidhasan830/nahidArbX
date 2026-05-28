import { and, eq } from "drizzle-orm";
import { mlModels } from "@/lib/db/schema";
import { logger } from "@/lib/shared/logger";
import { ML_TRAINING_STALE_TIMEOUT_MS } from "@/lib/shared/constants";

const tag = "MLTrainingWatchdog";

export const TRAINING_WATCHDOG_REASON_PREFIX =
  "Training watchdog marked this run failed";
export const TRAINING_INTERRUPTED_REASON_PREFIX =
  "Training launcher interrupted";

interface TrainingFreshnessInput {
  id: string;
  trainingStartedAt: string;
  lastHeartbeatAt: string | null;
}

export interface StaleTrainingRun {
  id: string;
  trainingStartedAt: string;
  lastHeartbeatAt: string | null;
  trainingStage: string | null;
  progressMessage: string | null;
  staleAgeMs: number;
}

export interface StaleTrainingReconciliation {
  checked: number;
  failed: StaleTrainingRun[];
}

function parseDbTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function getTrainingHeartbeatAgeMs(
  row: TrainingFreshnessInput,
  nowMs = Date.now(),
): number | null {
  const anchorMs =
    parseDbTime(row.lastHeartbeatAt) ?? parseDbTime(row.trainingStartedAt);
  return anchorMs === null ? null : nowMs - anchorMs;
}

export function isTrainingRunStale(
  row: TrainingFreshnessInput,
  nowMs = Date.now(),
  timeoutMs = ML_TRAINING_STALE_TIMEOUT_MS,
): boolean {
  const ageMs = getTrainingHeartbeatAgeMs(row, nowMs);
  return ageMs !== null && ageMs > timeoutMs;
}

function formatDurationMinutes(ms: number): string {
  return Math.max(1, Math.round(ms / 60_000)).toLocaleString();
}

export function staleTrainingReason(
  row: TrainingFreshnessInput,
  ageMs: number,
  timeoutMs = ML_TRAINING_STALE_TIMEOUT_MS,
): string {
  const anchor = row.lastHeartbeatAt ?? row.trainingStartedAt;
  return (
    `${TRAINING_WATCHDOG_REASON_PREFIX}: no heartbeat since ${anchor} ` +
    `(${formatDurationMinutes(ageMs)}m > ${formatDurationMinutes(timeoutMs)}m). ` +
    "The local launcher or Cloud Run job exited without writing a terminal status."
  );
}

export async function markTrainingRunFailed(
  modelId: string,
  reason: string,
  opts: { trainingSamples?: number } = {},
): Promise<void> {
  const { db, ensureDbReady } = await import("@/lib/db/client");
  await ensureDbReady();
  const nowIso = new Date().toISOString();
  const update = {
    status: "failed",
    rejectionReasons: [reason],
    trainingStage: "failed",
    progressMessage: reason,
    lastHeartbeatAt: nowIso,
    estimatedTimeRemainingMs: 0,
    trainingCompletedAt: nowIso,
    ...(typeof opts.trainingSamples === "number"
      ? { trainingSamples: opts.trainingSamples }
      : {}),
  };

  await db
    .update(mlModels)
    .set(update)
    .where(and(eq(mlModels.id, modelId), eq(mlModels.status, "training")));
}

export async function failStaleTrainingRuns(
  now = new Date(),
): Promise<StaleTrainingReconciliation> {
  const { db, ensureDbReady } = await import("@/lib/db/client");
  await ensureDbReady();
  const rows = await db
    .select({
      id: mlModels.id,
      trainingStartedAt: mlModels.trainingStartedAt,
      lastHeartbeatAt: mlModels.lastHeartbeatAt,
      trainingStage: mlModels.trainingStage,
      progressMessage: mlModels.progressMessage,
    })
    .from(mlModels)
    .where(eq(mlModels.status, "training"));

  const nowMs = now.getTime();
  const failed: StaleTrainingRun[] = [];

  for (const row of rows) {
    const ageMs = getTrainingHeartbeatAgeMs(row, nowMs);
    if (ageMs === null || ageMs <= ML_TRAINING_STALE_TIMEOUT_MS) {
      continue;
    }

    await markTrainingRunFailed(row.id, staleTrainingReason(row, ageMs));
    const stale: StaleTrainingRun = {
      ...row,
      staleAgeMs: ageMs,
    };
    failed.push(stale);
    logger.warn(
      tag,
      `Marked stale training run failed: ${row.id} (${formatDurationMinutes(ageMs)}m without heartbeat)`,
    );
  }

  return { checked: rows.length, failed };
}
