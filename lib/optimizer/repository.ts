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
      // fires pass through the schedule's own `notify_on_complete` /
      // `notify_on_start`. Both toggle independently.
      notifyOnComplete: req.notifyOnComplete ?? true,
      notifyOnStart: req.notifyOnStart ?? true,
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

/**
 * Atomically claim a single queued run for kickoff: flips status from
 * 'queued' → 'running' (only if it was still 'queued') and returns the
 * row. Returns null if the row was already claimed by another caller.
 *
 * This guards against the race where two scheduler ticks (or a manual
 * kick + scheduled tick) both see the same row in 'queued' and both
 * trigger a Job execution. With the WHERE-status='queued' filter on the
 * UPDATE, only the first writer wins; the second gets zero rows.
 */
export async function claimQueuedRun(
  runId: string,
): Promise<OptimizationRunRow | null> {
  const [row] = await db
    .update(optimizationRuns)
    .set({ status: "running" })
    .where(
      and(
        eq(optimizationRuns.id, runId),
        eq(optimizationRuns.status, "queued"),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Reverts a `running` row back to `queued` — paired with `claimQueuedRun`
 * for the case where the claim succeeded but the downstream Job trigger
 * failed (Cloud Run Admin API timeout, ADC hiccup, network blip).
 * Only flips rows that are still `running` AND have never started
 * (`started_at IS NULL` — once the sidecar writes started_at, the row
 * is in the sidecar's hands and we must not race it).
 */
export async function unclaimRun(runId: string): Promise<boolean> {
  const result = await db
    .update(optimizationRuns)
    .set({ status: "queued" })
    .where(
      and(
        eq(optimizationRuns.id, runId),
        eq(optimizationRuns.status, "running"),
        sql`${optimizationRuns.startedAt} IS NULL`,
      ),
    )
    .returning({ id: optimizationRuns.id });
  return result.length > 0;
}

/**
 * Reconcile rows that have been `running` with no progress for too long.
 *
 * A run is considered "stuck on claim" if all of these hold:
 *   - status = 'running'
 *   - started_at IS NULL (the Cloud Run Job never began executing)
 *   - n_trials_done = 0 (no progress)
 *   - created_at is older than `staleAfterSec`
 *
 * This is the durable safety net for the failure mode where the Next.js
 * process crashes BETWEEN `claimQueuedRun` and `triggerJobExecution` (so
 * neither the inline rollback in `kickRunNow` nor the one in the
 * scheduler tick gets a chance to run). Without this reconciler, the row
 * would sit in `running` forever — exactly the bug that left
 * "Quick 2026-04-25 16:17" stuck.
 *
 * Returns the IDs of rows that were reverted to `queued`.
 */
export async function reconcileStuckClaims(
  staleAfterSec = 120,
): Promise<string[]> {
  const rows = await db
    .update(optimizationRuns)
    .set({ status: "queued" })
    .where(
      and(
        eq(optimizationRuns.status, "running"),
        sql`${optimizationRuns.startedAt} IS NULL`,
        eq(optimizationRuns.nTrialsDone, 0),
        sql`${optimizationRuns.createdAt} < NOW() - (${staleAfterSec} || ' seconds')::interval`,
      ),
    )
    .returning({ id: optimizationRuns.id });
  return rows.map((r) => r.id);
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

// ── Run-duration ETA ─────────────────────────────────────────────────────
//
// Surfaces an estimate for how long a pending/submitted run will take so the
// UI can show "Estimated: ≈ 23m — based on 12 prior runs" and the "run
// started" Telegram message can include a finish time. We use the median
// (p50) of completed runs with the same (cv_strategy type, search_algorithm)
// whose `n_trials_target` is within ±25% of the submitted count.
//
// When we don't have ≥ 3 historical matches, we fall back to a rough
// heuristic — the sidecar evaluates ~1 trial per 400ms on a Cloud Run worker
// plus ~60s of bootstrap/scoring overhead. The `basis` string is
// transparent about which path we took so operators aren't surprised when
// the estimate is shaky.

export interface RunDurationEstimate {
  /** Median seconds to complete. null when no heuristic could be produced. */
  estimatedSec: number | null;
  /** Human-readable explanation — "p50 of 12 prior runs" or
   *  "heuristic (no prior data)". */
  basis: string;
  /** How many historical runs informed the estimate. 0 for heuristic. */
  sampleSize: number;
}

// Per-algorithm per-trial cost in seconds on a single core, against a
// 45-path CPCV (n_groups=10, n_test=2). Derived from reading the actual
// per-trial work in services/optimizer/app/runner.py + ml/evaluator.py:
//   - random / tpe / ensemble: ~0.2s (filter + Kelly sizing + bootstrap CI)
//   - nsga2: ~0.35s (genetic ops overhead)
//   - ml-xgboost: ~10s (trains an XGBoost model × 45 CPCV folds per trial)
// These are serial-loop baselines; the concurrency divisor below
// accounts for the parallel trial loop shipped alongside.
const HEURISTIC_SEC_PER_TRIAL_BY_ALGO: Record<string, number> = {
  random: 0.2,
  tpe: 0.25,
  ensemble: 0.25,
  nsga2: 0.35,
  "ml-xgboost": 10,
};

// Fold-count ratio: CPCV default = 45 paths, walk-forward default = 6.
// Per-trial time scales ~linearly with fold count (each fold is a
// filter+sizing pass, or a model fit for ML).
const CV_FOLD_MULTIPLIER: Record<string, number> = {
  cpcv: 1.0,
  walkforward: 6 / 45, // ~7.5× faster per trial
};

// Runtime parallelism baked into the Cloud Run deploy
// (OPTIMIZER_PARALLEL=1 + OPTIMIZER_MAX_CONCURRENCY=6 on 6-vCPU
// instance — 8-vCPU was intended but blocked by asia-south1's 20-vCPU
// regional quota; see cloudbuild.yaml for the full math). The runner's
// asyncio.Semaphore caps concurrent trials at this many; wall-clock
// per-run ≈ per-trial-cost / concurrency.
// Kept as a single constant rather than reading env because this file
// runs client-request-scoped from Next.js, not in the sidecar.
const RUNTIME_CONCURRENCY = 6;

const HEURISTIC_OVERHEAD_SEC = 45; // data load + split + final Pareto/PBO/WRC
const HISTORY_MIN_SAMPLE = 2; // Was 3; loosened so the historical branch
// fires sooner on a post-wipe fresh project.

// The Cloud Run parallelism + 8-vCPU deploy landed on this commit —
// runs completed before this instant were on the old serial loop and
// mustn't contaminate the post-parallel p50 window (they'd over-estimate
// ETAs by 8-10×). Absolute UTC so the filter is stable across clients.
const PARALLEL_RELEASE_CUTOFF_ISO = "2026-04-25T00:00:00Z";

function heuristicSecPerTrial(algorithm: string): number {
  return HEURISTIC_SEC_PER_TRIAL_BY_ALGO[algorithm] ?? 0.25;
}

export async function getEstimatedRunDurationSec(params: {
  nTrialsTarget: number;
  /** Accepts the whole cvStrategy JSON or just its `type` field. */
  cvStrategy: Pick<CvStrategyJson, "type"> | CvStrategyJson | string;
  searchAlgorithm: string;
}): Promise<RunDurationEstimate> {
  const cvType =
    typeof params.cvStrategy === "string"
      ? params.cvStrategy
      : (params.cvStrategy as CvStrategyJson).type;

  // Trials-count band was ±25% — too narrow to fire on small datasets.
  // ±50% gives the historical branch a realistic chance to kick in once
  // a handful of comparable runs exist.
  const lo = Math.floor(params.nTrialsTarget * 0.5);
  const hi = Math.ceil(params.nTrialsTarget * 1.5);

  const rows = await db.execute(sql`
    SELECT
      EXTRACT(EPOCH FROM (completed_at - started_at))::float AS secs
    FROM optimization_runs
    WHERE status = 'completed'
      AND started_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND completed_at >= ${PARALLEL_RELEASE_CUTOFF_ISO}::timestamptz
      AND search_algorithm = ${params.searchAlgorithm}
      AND (cv_strategy ->> 'type') = ${cvType}
      AND n_trials_target BETWEEN ${lo} AND ${hi}
    ORDER BY completed_at DESC
    LIMIT 40
  `);

  const durations: number[] = (rows.rows as Array<{ secs: number | null }>)
    .map((r) => (typeof r.secs === "number" ? r.secs : null))
    .filter((n): n is number => n != null && Number.isFinite(n) && n > 0);

  if (durations.length >= HISTORY_MIN_SAMPLE) {
    const sorted = [...durations].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const p50 =
      sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    return {
      estimatedSec: Math.round(p50),
      basis: `p50 of ${durations.length} prior runs`,
      sampleSize: durations.length,
    };
  }

  const cvMultiplier = CV_FOLD_MULTIPLIER[cvType] ?? 1.0;
  const perTrialSec =
    (heuristicSecPerTrial(params.searchAlgorithm) * cvMultiplier) /
    Math.max(1, RUNTIME_CONCURRENCY);
  const heuristic = params.nTrialsTarget * perTrialSec + HEURISTIC_OVERHEAD_SEC;
  return {
    estimatedSec: Math.round(heuristic),
    basis:
      durations.length === 0
        ? "heuristic (no prior data)"
        : `heuristic (only ${durations.length} comparable runs — too few to trust)`,
    sampleSize: durations.length,
  };
}

// ── Scope summary for notifications ──────────────────────────────────────
//
// Condenses a `DataFiltersJson` + the preview's bet count into a single
// human-readable line for the Telegram run-started message. Used server-side
// only — the in-app ETA chip has more room so it renders filters structurally.

export function formatScopeSummary(
  filters: DataFiltersJson | null | undefined,
): string {
  const f = filters ?? {};
  const parts: string[] = [];

  if (f.placedOnly) {
    parts.push("placed-only");
  }

  const from = f.eventStartFrom?.slice(0, 10);
  const to = f.eventStartTo?.slice(0, 10);
  if (from && to) parts.push(`${from} → ${to}`);
  else if (from) parts.push(`from ${from}`);
  else if (to) parts.push(`up to ${to}`);

  if (f.includeSoftProviders?.length) {
    parts.push(`books: ${f.includeSoftProviders.join(", ")}`);
  } else if (f.excludeSoftProviders?.length) {
    parts.push(`skip books: ${f.excludeSoftProviders.join(", ")}`);
  }

  if (f.includeMarketTypes?.length) {
    const show = f.includeMarketTypes.slice(0, 4).join(", ");
    const more =
      f.includeMarketTypes.length > 4
        ? ` +${f.includeMarketTypes.length - 4}`
        : "";
    parts.push(`markets: ${show}${more}`);
  } else if (f.excludeMarketTypes?.length) {
    parts.push(`skip markets: ${f.excludeMarketTypes.slice(0, 4).join(", ")}`);
  }

  return parts.length > 0 ? parts.join(" · ") : "All settled bets";
}

// ── CV strategy label for notifications ─────────────────────────────────

export function formatCvStrategyLabel(
  cv: CvStrategyJson | Record<string, unknown> | null | undefined,
): string {
  if (!cv) return "CPCV-10 (default)";
  const c = cv as Partial<CvStrategyJson>;
  const type = c.type ?? "cpcv";
  if (type === "walkforward") {
    const n = typeof c.n_groups === "number" ? c.n_groups : null;
    return n ? `Walk-forward (${n} windows)` : "Walk-forward";
  }
  const groups = typeof c.n_groups === "number" ? c.n_groups : 10;
  const test = typeof c.n_test_groups === "number" ? c.n_test_groups : 2;
  const embargoPct = typeof c.embargo_pct === "number" ? c.embargo_pct : 0.01;
  const embargoBets = Math.max(0, Math.round(embargoPct * 100));
  return `CPCV-${groups} pick-${test} (embargo ${embargoBets}%)`;
}

export type { OptimizationRunRow, OptimizationTrialRow, RunSummaryJson };
