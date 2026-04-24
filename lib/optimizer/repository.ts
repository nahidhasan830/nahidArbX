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

export type { OptimizationRunRow, OptimizationTrialRow, RunSummaryJson };
