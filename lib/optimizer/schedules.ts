/**
 * Schedule types + frequency math + repository.
 *
 * Frequency is a discriminated union — preset list rather than a free-form
 * cron string. Covers ~99% of real use ("daily 3am", "every 4 hours",
 * "weekly Sunday 6am") without forcing non-technical operators to learn
 * cron syntax. A free-form cron upgrade can be a follow-up if needed.
 *
 * Timezone rules:
 *   - `Frequency.hourLocal` is interpreted in `schedule.timezone` (default
 *     "Asia/Dhaka").
 *   - All timestamps stored in DB (`nextFireAt`, `lastFireAt`) are absolute
 *     UTC — the scheduler tick compares against `now()` in UTC, no conversion.
 */

import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  optimizationSchedules,
  type OptimizationScheduleRow,
} from "../db/schema";
import type {
  CvStrategyJson,
  DataFiltersJson,
  SearchAlgorithm,
  SearchSpaceJson,
} from "./types";

// ── Types ────────────────────────────────────────────────────────────────

export type Frequency =
  | { kind: "every_n_hours"; hours: 1 | 2 | 4 | 6 | 12 }
  | { kind: "daily"; hourLocal: number } // 0..23
  | { kind: "weekly"; dayOfWeek: number; hourLocal: number }; // 0=Sun..6=Sat

export interface CreateScheduleRequest {
  name: string;
  description?: string;
  enabled?: boolean;
  timezone?: string;
  frequency: Frequency;
  nTrialsTarget?: number;
  searchAlgorithm?: SearchAlgorithm;
  searchSpace?: SearchSpaceJson;
  cvStrategy?: Partial<CvStrategyJson>;
  dataFilters?: DataFiltersJson;
  notifyOnComplete?: boolean;
  createdBy?: string;
}

const DEFAULT_CV: CvStrategyJson = {
  type: "cpcv",
  n_groups: 10,
  n_test_groups: 2,
  embargo_pct: 0.01,
};

// ── Frequency math ──────────────────────────────────────────────────────
//
// Pure functions over Date. We avoid moment/luxon by computing the
// timezone offset via Intl.DateTimeFormat (works in Node 18+).

/**
 * Returns the UTC offset (in minutes) of the supplied IANA timezone
 * relative to UTC at the given instant. Positive for east-of-UTC.
 */
function tzOffsetMinutes(tz: string, when: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(when);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const local = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((local - when.getTime()) / 60000);
}

/**
 * Compute the next fire instant (UTC) AFTER `from`, given a frequency
 * and timezone. Always returns a Date strictly greater than `from`.
 */
export function nextFireTime(
  freq: Frequency,
  tz: string,
  from: Date = new Date(),
): Date {
  if (freq.kind === "every_n_hours") {
    // Snap to the next "hour boundary" that's a multiple of `hours`,
    // in UTC (timezone doesn't affect "every N hours" cadence).
    const next = new Date(from);
    next.setUTCMilliseconds(0);
    next.setUTCSeconds(0);
    next.setUTCMinutes(0);
    next.setUTCHours(
      Math.floor(next.getUTCHours() / freq.hours) * freq.hours + freq.hours,
    );
    return next;
  }

  // For daily / weekly, interpret hourLocal in the schedule's timezone.
  // Strategy: build a candidate at the desired local time today (or this
  // week's target weekday), convert to UTC, advance if it's already past.
  const offsetMin = tzOffsetMinutes(tz, from);
  // Build "now in tz" by adding the offset.
  const nowInTz = new Date(from.getTime() + offsetMin * 60_000);

  if (freq.kind === "daily") {
    const candidateLocal = new Date(
      Date.UTC(
        nowInTz.getUTCFullYear(),
        nowInTz.getUTCMonth(),
        nowInTz.getUTCDate(),
        freq.hourLocal,
        0,
        0,
      ),
    );
    let candidateUtc = new Date(candidateLocal.getTime() - offsetMin * 60_000);
    if (candidateUtc.getTime() <= from.getTime()) {
      // Already passed today — try tomorrow.
      candidateUtc = new Date(candidateUtc.getTime() + 24 * 3600_000);
    }
    return candidateUtc;
  }

  // weekly
  const todayDow = nowInTz.getUTCDay(); // 0..6 in tz-shifted clock
  const dayDelta = (freq.dayOfWeek - todayDow + 7) % 7;
  let candidateLocal = new Date(
    Date.UTC(
      nowInTz.getUTCFullYear(),
      nowInTz.getUTCMonth(),
      nowInTz.getUTCDate() + dayDelta,
      freq.hourLocal,
      0,
      0,
    ),
  );
  let candidateUtc = new Date(candidateLocal.getTime() - offsetMin * 60_000);
  if (candidateUtc.getTime() <= from.getTime()) {
    // Same weekday but already passed this week — push by 7 days.
    candidateLocal = new Date(candidateLocal.getTime() + 7 * 24 * 3600_000);
    candidateUtc = new Date(candidateLocal.getTime() - offsetMin * 60_000);
  }
  return candidateUtc;
}

/**
 * Plain-English description of a frequency. Used in the UI + log output.
 *   "Every 4 hours"
 *   "Daily at 03:00 (Asia/Dhaka)"
 *   "Weekly on Sunday at 06:00 (Asia/Dhaka)"
 */
export function describeFrequency(freq: Frequency, tz: string): string {
  if (freq.kind === "every_n_hours")
    return `Every ${freq.hours} hour${freq.hours === 1 ? "" : "s"}`;
  const hh = String(freq.hourLocal).padStart(2, "0");
  if (freq.kind === "daily") return `Daily at ${hh}:00 (${tz})`;
  const dows = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  return `Weekly on ${dows[freq.dayOfWeek] ?? "?"} at ${hh}:00 (${tz})`;
}

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
  // When re-enabling, recompute nextFireAt so we don't immediately fire if
  // the schedule was disabled past several windows.
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

// ── List runs produced by a schedule (history view) ──────────────────────
// We tag each schedule-fired run with createdBy = `schedule:<id>` so the
// schedule history view is just a filtered query against optimization_runs.

export const scheduleCreatedBy = (id: string): string => `schedule:${id}`;

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

export type { OptimizationScheduleRow };
