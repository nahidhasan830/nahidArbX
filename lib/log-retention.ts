import { lt, sql, type SQL } from "drizzle-orm";

import {
  LOG_RETENTION_CLEANUP_INTERVAL_MS,
  LOG_RETENTION_DAYS,
  LOG_RETENTION_STARTUP_DELAY_MS,
  LOG_RETENTION_TTL_MS,
} from "@/lib/shared/constants";
import { logger } from "@/lib/shared/logger";
import { singleton } from "@/lib/util/singleton";

export type LogRetentionTable =
  | "ai_logs"
  | "ai_search_logs"
  | "ai_activity_log"
  | "auto_placer_log"
  | "settlement_runs"
  | "telegram_command_history"
  | "event_matcher_run_job_events"
  | "event_matcher_run_jobs"
  | "activity_logs";

export type LogRetentionTableResult = {
  table: LogRetentionTable;
  deleted: number;
  durationMs: number;
};

export type LogRetentionResult = {
  cutoffIso: string;
  retentionDays: number;
  totalDeleted: number;
  tables: LogRetentionTableResult[];
};

type LogRetentionSchedulerState = {
  intervalTimer: ReturnType<typeof setInterval> | null;
  startupTimer: ReturnType<typeof setTimeout> | null;
  runPromise: Promise<LogRetentionResult> | null;
  lastRun: LogRetentionResult | null;
  lastError: string | null;
};

type PostgresLogDb = {
  execute(query: SQL): Promise<unknown>;
};

const schedulerState = singleton<LogRetentionSchedulerState>(
  "logRetentionScheduler",
  () => ({
    intervalTimer: null,
    startupTimer: null,
    runPromise: null,
    lastRun: null,
    lastError: null,
  }),
);

export function getLogRetentionCutoff(now = new Date()): Date {
  return new Date(now.getTime() - LOG_RETENTION_TTL_MS);
}

function deletedRowCount(result: unknown): number {
  const pgResult = result as { rowCount?: number | null; rows?: unknown[] };
  if (typeof pgResult.rowCount === "number") return pgResult.rowCount;
  if (Array.isArray(pgResult.rows)) return pgResult.rows.length;
  if (Array.isArray(result)) return result.length;
  return 0;
}

async function prunePostgresLogTable(
  table: LogRetentionTable,
  database: PostgresLogDb,
  query: SQL,
): Promise<LogRetentionTableResult> {
  const startedAt = Date.now();
  const result = await database.execute(query);
  return {
    table,
    deleted: deletedRowCount(result),
    durationMs: Date.now() - startedAt,
  };
}

async function pruneAuthActivityLogs(
  cutoff: Date,
): Promise<LogRetentionTableResult> {
  const { db: authDb, activityLogs } = await import("@/lib/auth/db");
  const startedAt = Date.now();
  const [{ count }] = await authDb
    .select({ count: sql<number>`count(*)` })
    .from(activityLogs)
    .where(lt(activityLogs.createdAt, cutoff));

  await authDb.delete(activityLogs).where(lt(activityLogs.createdAt, cutoff));

  return {
    table: "activity_logs",
    deleted: Number(count ?? 0),
    durationMs: Date.now() - startedAt,
  };
}

export async function pruneExpiredLogs(
  now = new Date(),
): Promise<LogRetentionResult> {
  const cutoff = getLogRetentionCutoff(now);
  const cutoffIso = cutoff.toISOString();
  const [
    { ensureDbReady, db: appDb },
    {
      aiActivityLog,
      aiLogs,
      aiSearchLogs,
      autoPlacerLog,
      eventMatcherRunJobEvents,
      eventMatcherRunJobs,
      settlementRuns,
      telegramCommandHistory,
    },
  ] = await Promise.all([
    import("@/lib/db/client"),
    import("@/lib/db/schema"),
  ]);
  await ensureDbReady();

  const tables = await Promise.all([
    prunePostgresLogTable(
      "ai_logs",
      appDb,
      sql`DELETE FROM ${aiLogs} WHERE ${aiLogs.createdAt} < ${cutoffIso}::timestamptz`,
    ),
    prunePostgresLogTable(
      "ai_search_logs",
      appDb,
      sql`DELETE FROM ${aiSearchLogs} WHERE ${aiSearchLogs.createdAt} < ${cutoffIso}::timestamptz`,
    ),
    prunePostgresLogTable(
      "ai_activity_log",
      appDb,
      sql`DELETE FROM ${aiActivityLog} WHERE ${aiActivityLog.createdAt} < ${cutoffIso}::timestamptz`,
    ),
    prunePostgresLogTable(
      "auto_placer_log",
      appDb,
      sql`DELETE FROM ${autoPlacerLog} WHERE ${autoPlacerLog.createdAt} < ${cutoffIso}::timestamptz`,
    ),
    prunePostgresLogTable(
      "settlement_runs",
      appDb,
      sql`DELETE FROM ${settlementRuns} WHERE ${settlementRuns.startedAt} < ${cutoffIso}::timestamptz`,
    ),
    prunePostgresLogTable(
      "telegram_command_history",
      appDb,
      sql`DELETE FROM ${telegramCommandHistory} WHERE ${telegramCommandHistory.at} < ${cutoffIso}::timestamptz`,
    ),
    prunePostgresLogTable(
      "event_matcher_run_job_events",
      appDb,
      sql`
        DELETE FROM ${eventMatcherRunJobEvents}
        WHERE ${eventMatcherRunJobEvents.jobId} IN (
          SELECT ${eventMatcherRunJobs.id}
          FROM ${eventMatcherRunJobs}
          WHERE ${eventMatcherRunJobs.createdAt} < ${cutoffIso}::timestamptz
            AND ${eventMatcherRunJobs.status} IN ('completed', 'failed')
        )
      `,
    ),
    prunePostgresLogTable(
      "event_matcher_run_jobs",
      appDb,
      sql`
        DELETE FROM ${eventMatcherRunJobs}
        WHERE ${eventMatcherRunJobs.createdAt} < ${cutoffIso}::timestamptz
          AND ${eventMatcherRunJobs.status} IN ('completed', 'failed')
      `,
    ),
    pruneAuthActivityLogs(cutoff),
  ]);

  return {
    cutoffIso,
    retentionDays: LOG_RETENTION_DAYS,
    totalDeleted: tables.reduce((sum, table) => sum + table.deleted, 0),
    tables,
  };
}

function runScheduledLogRetention(): void {
  if (schedulerState.runPromise) return;

  schedulerState.runPromise = pruneExpiredLogs()
    .then((result) => {
      schedulerState.lastRun = result;
      schedulerState.lastError = null;
      if (result.totalDeleted > 0) {
        logger.info(
          "LogRetention",
          `Pruned ${result.totalDeleted} log rows older than ${result.cutoffIso}`,
          result.tables,
        );
      } else {
        logger.debug(
          "LogRetention",
          `No log rows older than ${result.cutoffIso}`,
        );
      }
      return result;
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      schedulerState.lastError = message;
      logger.warn("LogRetention", `Cleanup failed: ${message}`);
      throw err;
    })
    .finally(() => {
      schedulerState.runPromise = null;
    });

  schedulerState.runPromise.catch(() => {});
}

export function startLogRetentionScheduler(): void {
  if (schedulerState.intervalTimer) return;

  schedulerState.startupTimer = setTimeout(
    runScheduledLogRetention,
    LOG_RETENTION_STARTUP_DELAY_MS,
  );
  schedulerState.startupTimer.unref?.();

  schedulerState.intervalTimer = setInterval(
    runScheduledLogRetention,
    LOG_RETENTION_CLEANUP_INTERVAL_MS,
  );
  schedulerState.intervalTimer.unref?.();

  logger.info(
    "LogRetention",
    `Scheduler started (${LOG_RETENTION_DAYS} day TTL, ${Math.round(
      LOG_RETENTION_CLEANUP_INTERVAL_MS / 60_000,
    )} min cadence)`,
  );
}

export function stopLogRetentionScheduler(): void {
  if (schedulerState.startupTimer) {
    clearTimeout(schedulerState.startupTimer);
    schedulerState.startupTimer = null;
  }
  if (schedulerState.intervalTimer) {
    clearInterval(schedulerState.intervalTimer);
    schedulerState.intervalTimer = null;
    logger.info("LogRetention", "Scheduler stopped");
  }
}

export function getLogRetentionStatus(): {
  active: boolean;
  running: boolean;
  lastRun: LogRetentionResult | null;
  lastError: string | null;
} {
  return {
    active: Boolean(schedulerState.intervalTimer),
    running: Boolean(schedulerState.runPromise),
    lastRun: schedulerState.lastRun,
    lastError: schedulerState.lastError,
  };
}
