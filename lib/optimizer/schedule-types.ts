/**
 * Client-safe types + pure helpers for AlphaSearch schedules.
 *
 * IMPORTANT: This module must NOT import anything that pulls in
 * `lib/db/client.ts` (which loads `@google-cloud/cloud-sql-connector`,
 * which requires Node-only `child_process`). Browser bundles can — and do —
 * import from here.
 *
 * The server-side repository lives in `lib/optimizer/schedules.ts`, which
 * re-exports symbols from this file alongside DB operations.
 */

import type { OptimizationScheduleRow } from "../db/schema";

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
  searchAlgorithm?: "random" | "tpe" | "nsga2" | "ensemble" | "ml-xgboost";
  searchSpace?: { dimensions: Array<Record<string, unknown>> };
  cvStrategy?: {
    type?: "cpcv" | "walkforward";
    n_groups?: number;
    n_test_groups?: number;
    embargo_pct?: number;
  };
  dataFilters?: Record<string, unknown>;
  notifyOnComplete?: boolean;
  createdBy?: string;
}

// ── Frequency math (pure) ────────────────────────────────────────────────
//
// Uses `Intl.DateTimeFormat` for timezone offsets — works everywhere
// (Node 18+, modern browsers). No moment/luxon dep.

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
    const next = new Date(from);
    next.setUTCMilliseconds(0);
    next.setUTCSeconds(0);
    next.setUTCMinutes(0);
    next.setUTCHours(
      Math.floor(next.getUTCHours() / freq.hours) * freq.hours + freq.hours,
    );
    return next;
  }

  const offsetMin = tzOffsetMinutes(tz, from);
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
      candidateUtc = new Date(candidateUtc.getTime() + 24 * 3600_000);
    }
    return candidateUtc;
  }

  // weekly
  const todayDow = nowInTz.getUTCDay();
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
    candidateLocal = new Date(candidateLocal.getTime() + 7 * 24 * 3600_000);
    candidateUtc = new Date(candidateLocal.getTime() - offsetMin * 60_000);
  }
  return candidateUtc;
}

/**
 * Plain-English description of a frequency. Used in the UI + log output.
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

/** Tag used on `optimization_runs.created_by` when a schedule fires. */
export const scheduleCreatedBy = (id: string): string => `schedule:${id}`;

export type { OptimizationScheduleRow };
