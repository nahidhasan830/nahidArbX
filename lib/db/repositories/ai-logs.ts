/**
 * Repository for the unified ai_logs table.
 *
 * Write path: fire-and-forget logging from all AI operations:
 * - ai-search proxy (grounding, entity-match, settlement)
 * - Settlement (Gemini Tier 3)
 * - Entity matching (ML models)
 * - Analysis (Propose rules)
 *
 * Read path: paginated query for the UI + stats aggregation.
 */

import { and, desc, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../client";
import { aiLogs, type AiLogRow, type NewAiLogRow } from "../schema";
import { logger } from "@/lib/shared/logger";

export type AiLogInput = Omit<NewAiLogRow, "id" | "createdAt">;

const MAX_JSON_SIZE = 16384; // 16KB limit for request/response payloads

/**
 * Truncate JSON to max size, preserving valid JSON structure.
 */
function truncateJson(obj: unknown): object | null {
  if (obj === null || obj === undefined) return null;
  try {
    const str = JSON.stringify(obj);
    if (str.length <= MAX_JSON_SIZE) return obj as object;
    // Parse back to ensure valid JSON after truncation
    return JSON.parse(str.slice(0, MAX_JSON_SIZE - 1) + "}");
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget — never blocks the AI pipeline.
 */
export async function recordAiLog(input: AiLogInput): Promise<void> {
  try {
    await db.insert(aiLogs).values({
      ...input,
      requestBody: truncateJson(input.requestBody),
      responseBody: truncateJson(input.responseBody),
    });
  } catch (err) {
    logger.error("AiLog", `Failed to record: ${(err as Error).message}`);
  }
}

export type AiLogFilters = {
  from?: string;
  to?: string;
  systems?: string[];
  statuses?: string[];
  triggers?: string[];
  endpoints?: string[];
  search?: string;
  limit?: number;
  offset?: number;
};

const buildFilterClauses = (filters: AiLogFilters) => {
  const clauses = [];
  if (filters.from) clauses.push(gte(aiLogs.createdAt, filters.from));
  if (filters.to) clauses.push(lte(aiLogs.createdAt, filters.to));
  if (filters.systems?.length) {
    clauses.push(inArray(aiLogs.system, filters.systems));
  }
  if (filters.statuses?.length) {
    clauses.push(inArray(aiLogs.status, filters.statuses));
  }
  if (filters.triggers?.length) {
    clauses.push(inArray(aiLogs.trigger, filters.triggers));
  }
  if (filters.endpoints?.length) {
    clauses.push(inArray(aiLogs.endpoint, filters.endpoints));
  }
  if (filters.search) {
    const q = `%${filters.search}%`;
    clauses.push(
      sql`(COALESCE(${aiLogs.summary}, '') ILIKE ${q} OR COALESCE(${aiLogs.error}, '') ILIKE ${q} OR COALESCE(${aiLogs.model}, '') ILIKE ${q})`,
    );
  }
  return clauses;
};

export async function listAiLogs(
  filters: AiLogFilters = {},
): Promise<{ rows: AiLogRow[]; total: number }> {
  const clauses = buildFilterClauses(filters);
  const where = clauses.length ? and(...clauses) : undefined;

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(aiLogs)
      .where(where)
      .orderBy(desc(aiLogs.createdAt))
      .limit(filters.limit ?? 200)
      .offset(filters.offset ?? 0),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiLogs)
      .where(where),
  ]);

  return { rows, total: countResult[0]?.count ?? 0 };
}

export async function getAiLogById(id: number): Promise<AiLogRow | null> {
  const [row] = await db
    .select()
    .from(aiLogs)
    .where(sql`${aiLogs.id} = ${id}`);
  return row ?? null;
}

export type AiLogStats = {
  total: number;
  success: number;
  error: number;
  partial: number;
  totalCostUsd: number;
  avgDurationMs: number;
};

export async function aggregateAiLogs(
  filters: AiLogFilters = {},
): Promise<AiLogStats> {
  const clauses = buildFilterClauses(filters);
  const where = clauses.length ? and(...clauses) : undefined;

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      success: sql<number>`count(*) FILTER (WHERE ${aiLogs.status} = 'success')::int`,
      error: sql<number>`count(*) FILTER (WHERE ${aiLogs.status} = 'error')::int`,
      partial: sql<number>`count(*) FILTER (WHERE ${aiLogs.status} = 'partial')::int`,
      totalCostUsd: sql<number>`COALESCE(sum(${aiLogs.costUsd}), 0)::numeric(8,5)`,
      avgDurationMs: sql<number>`COALESCE(avg(${aiLogs.durationMs}), 0)::int`,
    })
    .from(aiLogs)
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
