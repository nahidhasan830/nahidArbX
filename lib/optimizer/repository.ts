/**
 * Repository for `optimization_runs` + `optimization_trials`.
 *
 * Read-side only — all writes to trials happen from the Python sidecar.
 * Writes from this file are limited to:
 *   - creating new run rows (queued status)
 *   - cancelling runs (status='cancelled' flip)
 *   - the Next.js scheduler doesn't write trial rows; it just kicks the sidecar.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  optimizationRuns,
  optimizationTrials,
  type OptimizationRunRow,
  type OptimizationTrialRow,
} from "../db/schema";
import type {
  CreateRunRequest,
  CvStrategyJson,
  DataFiltersJson,
  RunSummaryJson,
  SearchSpaceJson,
} from "./types";

const DEFAULT_CV: CvStrategyJson = {
  type: "cpcv",
  n_groups: 10,
  n_test_groups: 2,
  embargo_pct: 0.01,
};

const ulidLike = (): string => {
  // Lightweight unique id (timestamp-prefixed random). Avoids adding the
  // `ulid` npm dep — same monotonic-ish ordering for our needs.
  const ts = Date.now().toString(36).padStart(10, "0");
  const rand = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36),
  ).join("");
  return `${ts}${rand}`.toUpperCase();
};

export async function createRun(
  req: CreateRunRequest,
): Promise<OptimizationRunRow> {
  const id = ulidLike();
  const cvStrategy: CvStrategyJson = {
    ...DEFAULT_CV,
    ...(req.cvStrategy ?? {}),
  };
  const searchSpace: SearchSpaceJson = req.searchSpace ?? { dimensions: [] };
  const dataFilters: DataFiltersJson = req.dataFilters ?? {};
  const rngSeed = req.rngSeed ?? Math.floor(Math.random() * 2_147_483_647);

  const [row] = await db
    .insert(optimizationRuns)
    .values({
      id,
      name: req.name,
      status: "queued",
      searchSpace,
      searchAlgorithm: req.searchAlgorithm,
      nTrialsTarget: req.nTrialsTarget,
      rngSeed,
      cvStrategy,
      dataFilters,
      // Manual UI runs default to receiving a Telegram ping; scheduled
      // fires pass through the schedule's own `notify_on_complete`.
      notifyOnComplete: req.notifyOnComplete ?? true,
      createdBy: req.createdBy ?? null,
    })
    .returning();

  return row;
}

export async function listRuns(limit = 100): Promise<OptimizationRunRow[]> {
  return db
    .select()
    .from(optimizationRuns)
    .orderBy(desc(optimizationRuns.createdAt))
    .limit(limit);
}

export async function getRun(id: string): Promise<OptimizationRunRow | null> {
  const rows = await db
    .select()
    .from(optimizationRuns)
    .where(eq(optimizationRuns.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function cancelRun(id: string): Promise<boolean> {
  const result = await db
    .update(optimizationRuns)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(optimizationRuns.id, id),
        sql`${optimizationRuns.status} IN ('queued','running')`,
      ),
    )
    .returning({ id: optimizationRuns.id });
  return result.length > 0;
}

export async function listQueuedRuns(): Promise<OptimizationRunRow[]> {
  return db
    .select()
    .from(optimizationRuns)
    .where(eq(optimizationRuns.status, "queued"))
    .orderBy(optimizationRuns.createdAt);
}

export async function listTrials(
  runId: string,
  opts: {
    limit?: number;
    offset?: number;
    paretoOnly?: boolean;
    sortBy?: "composite" | "roi" | "sample_size" | "drawdown";
    sortDir?: "asc" | "desc";
  } = {},
): Promise<OptimizationTrialRow[]> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const offset = opts.offset ?? 0;
  const sortDir = opts.sortDir ?? "desc";

  const orderCol = (() => {
    switch (opts.sortBy) {
      case "roi":
        return optimizationTrials.oosRoiMean;
      case "sample_size":
        return optimizationTrials.sampleSize;
      case "drawdown":
        return optimizationTrials.maxDrawdown;
      default:
        return optimizationTrials.compositeScore;
    }
  })();

  const where = opts.paretoOnly
    ? and(
        eq(optimizationTrials.runId, runId),
        eq(optimizationTrials.onPareto, true),
      )
    : eq(optimizationTrials.runId, runId);

  return db
    .select()
    .from(optimizationTrials)
    .where(where)
    .orderBy(sortDir === "asc" ? orderCol : desc(orderCol))
    .limit(limit)
    .offset(offset);
}

// ── Dataset preview ──────────────────────────────────────────────────────
//
// Mirror of the SQL the Python sidecar runs in `loader.py`. Lets the UI
// show "X of Y bets included" as the user toggles filters BEFORE submitting.
// Source of truth for filter semantics is still the Python side; this
// duplicate exists to keep the preview snappy without a sidecar round-trip.

export interface DatasetPreview {
  total: number;
  included: number;
  byProvider: Array<{ provider: string; count: number }>;
  byMarket: Array<{ market: string; count: number }>;
}

export async function previewDataset(
  filters: DataFiltersJson,
): Promise<DatasetPreview> {
  const conds: ReturnType<typeof sql>[] = [
    sql`outcome IN ('won','half_won','lost','half_lost','void')`,
  ];

  if (filters.placedOnly) {
    conds.push(sql`placed_at IS NOT NULL`);
  }
  if (filters.includeSoftProviders?.length) {
    conds.push(sql`soft_provider = ANY(${filters.includeSoftProviders})`);
  } else if (filters.excludeSoftProviders?.length) {
    conds.push(sql`soft_provider <> ALL(${filters.excludeSoftProviders})`);
  }
  if (filters.includeMarketTypes?.length) {
    conds.push(sql`market_type = ANY(${filters.includeMarketTypes})`);
  } else if (filters.excludeMarketTypes?.length) {
    conds.push(sql`market_type <> ALL(${filters.excludeMarketTypes})`);
  }
  if (filters.eventStartFrom) {
    conds.push(sql`event_start_time >= ${filters.eventStartFrom}`);
  }
  if (filters.eventStartTo) {
    conds.push(sql`event_start_time < ${filters.eventStartTo}`);
  }

  // Build the WHERE clause. Drizzle's raw sql<T> tagged template handles arrays.
  const whereSql = sql.join(conds, sql` AND `);

  const totalRows = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM bets WHERE outcome IN ('won','half_won','lost','half_lost','void')`,
  );
  const includedRows = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM bets WHERE ${whereSql}`,
  );
  const byProviderRows = await db.execute(
    sql`SELECT soft_provider AS provider, COUNT(*)::int AS count
        FROM bets WHERE ${whereSql}
        GROUP BY soft_provider ORDER BY count DESC`,
  );
  const byMarketRows = await db.execute(
    sql`SELECT market_type AS market, COUNT(*)::int AS count
        FROM bets WHERE ${whereSql}
        GROUP BY market_type ORDER BY count DESC LIMIT 25`,
  );

  return {
    total: Number((totalRows.rows[0] as { n: number } | undefined)?.n ?? 0),
    included: Number(
      (includedRows.rows[0] as { n: number } | undefined)?.n ?? 0,
    ),
    byProvider:
      (byProviderRows.rows as Array<{ provider: string; count: number }>) ?? [],
    byMarket:
      (byMarketRows.rows as Array<{ market: string; count: number }>) ?? [],
  };
}

export type { OptimizationRunRow, OptimizationTrialRow, RunSummaryJson };
