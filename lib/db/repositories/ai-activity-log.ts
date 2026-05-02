/**
 * Repository for the ai_activity_log table.
 *
 * Write side: `recordAiActivity` — fire-and-forget, called from
 * settlement batch, ai-search proxy, and analysis routes whenever
 * an AI operation completes (success, error, or partial).
 *
 * Read side: `listAiActivityLog` — paginated query for the UI with
 * filtering by system, status, trigger, date range, and search.
 *        `aggregateAiActivityLog` — summary stats for the toolbar.
 */
import { and, desc, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../client";
import {
  aiActivityLog,
  type AiActivityLogRow,
  type NewAiActivityLogRow,
} from "../schema";
import { logger } from "@/lib/shared/logger";

// ─── Write ────────────────────────────────────────────────────────────────────

export type AiActivityInput = Omit<NewAiActivityLogRow, "id" | "createdAt">;

/**
 * Fire-and-forget — never blocks the AI pipeline. Failures
 * are logged but never propagated.
 */
export async function recordAiActivity(
  input: AiActivityInput,
): Promise<void> {
  try {
    await db.insert(aiActivityLog).values(input);
  } catch (err) {
    logger.error(
      "AiActivityLog",
      `Failed to record activity: ${(err as Error).message}`,
    );
  }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export type AiActivityLogFilters = {
  /** ISO date lower bound (createdAt). */
  from?: string;
  /** ISO date upper bound (createdAt). */
  to?: string;
  /** Filter by system(s). */
  systems?: string[];
  /** Filter by status(es). */
  statuses?: string[];
  /** Filter by trigger(s). */
  triggers?: string[];
  /** Text search across summary/error/model. */
  search?: string;
  limit?: number;
  offset?: number;
};

const buildFilterClauses = (filters: AiActivityLogFilters) => {
  const clauses = [];
  if (filters.from) clauses.push(gte(aiActivityLog.createdAt, filters.from));
  if (filters.to) clauses.push(lte(aiActivityLog.createdAt, filters.to));
  if (filters.systems?.length) {
    clauses.push(inArray(aiActivityLog.system, filters.systems));
  }
  if (filters.statuses?.length) {
    clauses.push(inArray(aiActivityLog.status, filters.statuses));
  }
  if (filters.triggers?.length) {
    clauses.push(inArray(aiActivityLog.trigger, filters.triggers));
  }
  if (filters.search) {
    const q = `%${filters.search}%`;
    clauses.push(
      sql`(COALESCE(${aiActivityLog.summary}, '') ILIKE ${q} OR COALESCE(${aiActivityLog.error}, '') ILIKE ${q} OR COALESCE(${aiActivityLog.model}, '') ILIKE ${q})`,
    );
  }
  return clauses;
};

export async function listAiActivityLog(
  filters: AiActivityLogFilters = {},
): Promise<{ rows: AiActivityLogRow[]; total: number }> {
  const clauses = buildFilterClauses(filters);
  const where = clauses.length ? and(...clauses) : undefined;

  const rows = await db
    .select()
    .from(aiActivityLog)
    .where(where)
    .orderBy(desc(aiActivityLog.createdAt))
    .limit(filters.limit ?? 200)
    .offset(filters.offset ?? 0);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(aiActivityLog)
    .where(where);

  return { rows, total: count ?? 0 };
}

export type AiActivityLogStats = {
  total: number;
  success: number;
  error: number;
  partial: number;
  totalCostUsd: number;
  avgDurationMs: number;
};

export async function aggregateAiActivityLog(
  filters: AiActivityLogFilters = {},
): Promise<AiActivityLogStats> {
  const clauses = buildFilterClauses(filters);
  const where = clauses.length ? and(...clauses) : undefined;

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      success: sql<number>`count(*) FILTER (WHERE ${aiActivityLog.status} = 'success')::int`,
      error: sql<number>`count(*) FILTER (WHERE ${aiActivityLog.status} = 'error')::int`,
      partial: sql<number>`count(*) FILTER (WHERE ${aiActivityLog.status} = 'partial')::int`,
      totalCostUsd: sql<number>`COALESCE(sum(${aiActivityLog.costUsd}), 0)::numeric(8,5)`,
      avgDurationMs: sql<number>`COALESCE(avg(${aiActivityLog.durationMs}), 0)::int`,
    })
    .from(aiActivityLog)
    .where(where);

  return {
    total: row?.total ?? 0,
    success: row?.success ?? 0,
    error: row?.error ?? 0,
    partial: row?.partial ?? 0,
    totalCostUsd: Number(row?.totalCostUsd ?? 0),
    avgDurationMs: row?.avgDurationMs ?? 0,
  };
}
