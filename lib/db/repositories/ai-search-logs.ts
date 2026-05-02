/**
 * Repository for ai_search_logs — append-only audit trail.
 *
 * Write path: called from the Next.js proxy route after every
 * upstream call to the Python ai-search service.
 *
 * Read path: paginated list for the Logs DataTable on /ai-search.
 */

import { desc, eq, and, sql } from "drizzle-orm";
import { db } from "../client";
import { aiSearchLogs, type NewAiSearchLogRow } from "../schema";

export async function insertAiSearchLog(row: NewAiSearchLogRow) {
  await db.insert(aiSearchLogs).values(row);
}

export type AiSearchLogFilters = {
  status?: "success" | "error";
  service?: string;
  limit?: number;
  offset?: number;
};

export async function listAiSearchLogs(filters: AiSearchLogFilters = {}) {
  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  const conditions = [];
  if (filters.status) {
    conditions.push(eq(aiSearchLogs.status, filters.status));
  }
  if (filters.service) {
    conditions.push(eq(aiSearchLogs.service, filters.service));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(aiSearchLogs)
      .where(where)
      .orderBy(desc(aiSearchLogs.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(aiSearchLogs)
      .where(where),
  ]);

  return { rows, total: countResult[0]?.count ?? 0 };
}
