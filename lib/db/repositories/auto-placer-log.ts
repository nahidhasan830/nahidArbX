import { and, desc, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "../client";
import {
  autoPlacerLog,
  type AutoPlacerLogRow,
  type NewAutoPlacerLogRow,
} from "../schema";
import { logger } from "@/lib/shared/logger";


export type LogDecisionInput = Omit<NewAutoPlacerLogRow, "id" | "createdAt">;

export async function recordDecision(input: LogDecisionInput): Promise<void> {
  try {
    await db.insert(autoPlacerLog).values(input);
  } catch (err) {
    logger.error(
      "AutoPlacerLog",
      `Failed to record decision: ${(err as Error).message}`,
    );
  }
}


export type AutoPlacerLogFilters = {
  from?: string;
  to?: string;
  statuses?: string[];
  gates?: string[];
  softProviders?: string[];
  search?: string;
  limit?: number;
  offset?: number;
};

const buildFilterClauses = (filters: AutoPlacerLogFilters) => {
  const clauses = [];
  if (filters.from) clauses.push(gte(autoPlacerLog.createdAt, filters.from));
  if (filters.to) clauses.push(lte(autoPlacerLog.createdAt, filters.to));
  if (filters.statuses?.length) {
    clauses.push(inArray(autoPlacerLog.status, filters.statuses));
  }
  if (filters.gates?.length) {
    clauses.push(inArray(autoPlacerLog.gate, filters.gates));
  }
  if (filters.softProviders?.length) {
    clauses.push(inArray(autoPlacerLog.softProvider, filters.softProviders));
  }
  if (filters.search) {
    const q = `%${filters.search}%`;
    clauses.push(
      sql`(${autoPlacerLog.homeTeam} ILIKE ${q} OR ${autoPlacerLog.awayTeam} ILIKE ${q} OR COALESCE(${autoPlacerLog.competition}, '') ILIKE ${q} OR ${autoPlacerLog.reason} ILIKE ${q})`,
    );
  }
  return clauses;
};

export async function listAutoPlacerLog(
  filters: AutoPlacerLogFilters = {},
): Promise<{ rows: AutoPlacerLogRow[]; total: number }> {
  const clauses = buildFilterClauses(filters);
  const where = clauses.length ? and(...clauses) : undefined;

  const rows = await db
    .select()
    .from(autoPlacerLog)
    .where(where)
    .orderBy(desc(autoPlacerLog.createdAt))
    .limit(filters.limit ?? 200)
    .offset(filters.offset ?? 0);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(autoPlacerLog)
    .where(where);

  return { rows, total: count ?? 0 };
}

export type AutoPlacerLogStats = {
  total: number;
  placed: number;
  pending: number;
  skipped: number;
  rejected: number;
  errored: number;
};

export async function aggregateAutoPlacerLog(
  filters: AutoPlacerLogFilters = {},
): Promise<AutoPlacerLogStats> {
  const clauses = buildFilterClauses(filters);
  const where = clauses.length ? and(...clauses) : undefined;

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      placed: sql<number>`count(*) FILTER (WHERE ${autoPlacerLog.status} = 'placed')::int`,
      pending: sql<number>`count(*) FILTER (WHERE ${autoPlacerLog.status} = 'pending')::int`,
      skipped: sql<number>`count(*) FILTER (WHERE ${autoPlacerLog.status} = 'skipped')::int`,
      rejected: sql<number>`count(*) FILTER (WHERE ${autoPlacerLog.status} = 'rejected')::int`,
      errored: sql<number>`count(*) FILTER (WHERE ${autoPlacerLog.status} = 'error')::int`,
    })
    .from(autoPlacerLog)
    .where(where);

  return {
    total: row?.total ?? 0,
    placed: row?.placed ?? 0,
    pending: row?.pending ?? 0,
    skipped: row?.skipped ?? 0,
    rejected: row?.rejected ?? 0,
    errored: row?.errored ?? 0,
  };
}
