/**
 * Server-side schedule repository.
 *
 * Pure types + frequency math live in `./schedule-types` (client-safe — no
 * `db` import). This module imports those + adds the Postgres-touching
 * CRUD. **Never import this file from a client component** — it pulls in
 * the Cloud SQL connector via `db/client.ts`.
 */

import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import { db } from "../db/client";
import { optimizationSchedules } from "../db/schema";
import {
  nextFireTime,
  scheduleCreatedBy,
  type CreateScheduleRequest,
  type Frequency,
  type OptimizationScheduleRow,
} from "./schedule-types";
import type { CvStrategyJson } from "./types";

// Re-export pure helpers + types so existing server-side imports keep working.
export {
  describeFrequency,
  nextFireTime,
  scheduleCreatedBy,
  type CreateScheduleRequest,
  type Frequency,
  type OptimizationScheduleRow,
} from "./schedule-types";

const DEFAULT_CV: CvStrategyJson = {
  type: "cpcv",
  n_groups: 10,
  n_test_groups: 2,
  embargo_pct: 0.01,
};

// ── Repository ───────────────────────────────────────────────────────────

const ulidLike = (): string => {
  const ts = Date.now().toString(36).padStart(10, "0");
  const rand = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 36).toString(36),
  ).join("");
  return `${ts}${rand}`.toUpperCase();
};

export async function createSchedule(
  req: CreateScheduleRequest,
): Promise<OptimizationScheduleRow> {
  const id = ulidLike();
  const tz = req.timezone ?? "Asia/Dhaka";
  const cv: CvStrategyJson = { ...DEFAULT_CV, ...(req.cvStrategy ?? {}) };
  const next = nextFireTime(req.frequency, tz);

  const [row] = await db
    .insert(optimizationSchedules)
    .values({
      id,
      name: req.name,
      description: req.description ?? null,
      enabled: req.enabled ?? true,
      timezone: tz,
      frequency: req.frequency,
      nTrialsTarget: req.nTrialsTarget ?? 2000,
      searchAlgorithm: req.searchAlgorithm ?? "ensemble",
      searchSpace: req.searchSpace ?? { dimensions: [] },
      cvStrategy: cv,
      dataFilters: req.dataFilters ?? {},
      notifyOnComplete: req.notifyOnComplete ?? false,
      nextFireAt: next.toISOString(),
      createdBy: req.createdBy ?? null,
    })
    .returning();
  return row;
}

export async function listSchedules(): Promise<OptimizationScheduleRow[]> {
  return db
    .select()
    .from(optimizationSchedules)
    .orderBy(desc(optimizationSchedules.createdAt));
}

export async function getSchedule(
  id: string,
): Promise<OptimizationScheduleRow | null> {
  const rows = await db
    .select()
    .from(optimizationSchedules)
    .where(eq(optimizationSchedules.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function listDueSchedules(): Promise<OptimizationScheduleRow[]> {
  const nowIso = new Date().toISOString();
  return db
    .select()
    .from(optimizationSchedules)
    .where(
      and(
        eq(optimizationSchedules.enabled, true),
        lte(optimizationSchedules.nextFireAt, nowIso),
      ),
    )
    .orderBy(asc(optimizationSchedules.nextFireAt));
}

export async function updateScheduleAfterFire(
  id: string,
  runId: string,
): Promise<void> {
  const sched = await getSchedule(id);
  if (!sched) return;
  const next = nextFireTime(sched.frequency as Frequency, sched.timezone);
  await db
    .update(optimizationSchedules)
    .set({
      lastFireAt: new Date().toISOString(),
      lastRunId: runId,
      nextFireAt: next.toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(optimizationSchedules.id, id));
}

export async function setScheduleEnabled(
  id: string,
  enabled: boolean,
): Promise<boolean> {
  if (enabled) {
    const sched = await getSchedule(id);
    if (!sched) return false;
    const next = nextFireTime(sched.frequency as Frequency, sched.timezone);
    const result = await db
      .update(optimizationSchedules)
      .set({
        enabled: true,
        nextFireAt: next.toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(optimizationSchedules.id, id))
      .returning({ id: optimizationSchedules.id });
    return result.length > 0;
  }
  const result = await db
    .update(optimizationSchedules)
    .set({ enabled: false, updatedAt: new Date().toISOString() })
    .where(eq(optimizationSchedules.id, id))
    .returning({ id: optimizationSchedules.id });
  return result.length > 0;
}

export async function deleteSchedule(id: string): Promise<boolean> {
  const result = await db
    .delete(optimizationSchedules)
    .where(eq(optimizationSchedules.id, id))
    .returning({ id: optimizationSchedules.id });
  return result.length > 0;
}

export async function listRunsForSchedule(
  scheduleId: string,
  limit = 50,
): Promise<
  Array<{
    id: string;
    status: string;
    createdAt: string;
    nTrialsDone: number;
    nTrialsTarget: number;
  }>
> {
  const rows = await db.execute(
    sql`SELECT id, status, created_at AS "createdAt",
               n_trials_done AS "nTrialsDone",
               n_trials_target AS "nTrialsTarget"
        FROM optimization_runs
        WHERE created_by = ${scheduleCreatedBy(scheduleId)}
        ORDER BY created_at DESC
        LIMIT ${limit}`,
  );
  return rows.rows as Array<{
    id: string;
    status: string;
    createdAt: string;
    nTrialsDone: number;
    nTrialsTarget: number;
  }>;
}
