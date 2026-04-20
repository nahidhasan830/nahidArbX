/**
 * In-memory ring buffer of recent settlement-scheduler activity.
 *
 * Feeds the admin "Activity Monitor" UI without requiring a DB round-trip.
 * Entries are ephemeral — on process restart the buffer resets; durable
 * telemetry lives in the `settlement_runs` Postgres table.
 *
 * Also emits each appended entry onto the global event bus so SSE clients
 * can stream them live rather than polling.
 */

import { syncBus } from "../events/event-bus";

export type ActivityLevel = "debug" | "info" | "warn" | "error";

export type ActivityKind =
  | "tick:start"
  | "tick:end"
  | "tick:error"
  | "tick:skipped"
  | "state:start"
  | "state:stop"
  | "state:pause"
  | "state:resume"
  | "state:disable"
  | "state:enable"
  | "manual:run"
  | "note";

export interface ActivityEntry {
  id: string;
  ts: number;
  level: ActivityLevel;
  kind: ActivityKind;
  message: string;
  data?: Record<string, unknown>;
}

const MAX_ENTRIES = 200;

const buffer: ActivityEntry[] = [];
let nextId = 1;

export function appendActivity(
  kind: ActivityKind,
  level: ActivityLevel,
  message: string,
  data?: Record<string, unknown>,
): ActivityEntry {
  const entry: ActivityEntry = {
    id: `${Date.now()}-${nextId++}`,
    ts: Date.now(),
    level,
    kind,
    message,
    data,
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
  syncBus.emitBus({ type: "settle:log", entry });
  return entry;
}

export function getActivityLog(limit = 100): ActivityEntry[] {
  if (limit >= buffer.length) return [...buffer];
  return buffer.slice(buffer.length - limit);
}

export function clearActivityLog(): void {
  buffer.length = 0;
}
