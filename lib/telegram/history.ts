/**
 * In-memory ring buffer of incoming commands the bot has dispatched.
 *
 * Powers the dashboard's "command history" panel and the `/history`
 * Telegram command. The dashboard re-fetches via smart polling
 * (visibility-aware) so we don't need a push channel here.
 *
 * Process-local, capped at 200 entries — pinned to globalThis so HMR
 * doesn't fragment it across module copies.
 */

import { singleton } from "@/lib/util/singleton";

export interface CommandHistoryEntry {
  /** ISO timestamp when the bot received the command. */
  at: string;
  /** Command name without the leading slash, e.g. "status". */
  command: string;
  /** Full text the user sent, including args. Truncated to 200 chars. */
  text: string;
  /** Telegram user id who sent it (for diagnosing rogue chats). */
  fromUserId: number | null;
  /** "ok" if the handler returned, "denied" if disabled, "unknown" if no
   *  command, "error" if the handler threw. */
  outcome: "ok" | "denied" | "unknown" | "error";
  /** Wall-clock duration of the handler in milliseconds. */
  durationMs: number;
  /** Error message when outcome === "error". */
  error?: string | null;
}

const MAX = 200;

interface HistoryState {
  entries: CommandHistoryEntry[];
  /**
   * Permanent (since-boot) counter — keyed by command name. Survives
   * the 200-entry ring eviction so the dashboard's "Calls" column is
   * accurate for as long as the process has been up.
   */
  counts: Map<string, number>;
}

// One-time cleanup of stale slots from earlier shape iterations during
// active dev. Dev-server HMR pins state to globalThis across reloads,
// and we briefly used a ":v2" key while iterating on this module — the
// `delete` here drops that orphan so a long-running dev process doesn't
// hold onto data we no longer reference.
delete (globalThis as unknown as Record<string, unknown>)[
  "__nahidArbX_telegram:cmd-history:v2__"
];

const buf = singleton<HistoryState>("telegram:cmd-history", () => ({
  entries: [],
  counts: new Map(),
}));

// Defensive accessors — backfill the fields if a long-running dev
// process is still pointed at an older shape. Cheap, and prevents the
// route handlers from 500ing on a partially-shaped buf.
function getEntries(): CommandHistoryEntry[] {
  if (!Array.isArray(buf.entries)) buf.entries = [];
  return buf.entries;
}
function getCounts(): Map<string, number> {
  if (!(buf.counts instanceof Map)) buf.counts = new Map();
  return buf.counts;
}

export function recordCommandHistory(entry: CommandHistoryEntry): void {
  const entries = getEntries();
  entries.push(entry);
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
  const counts = getCounts();
  counts.set(entry.command, (counts.get(entry.command) ?? 0) + 1);
}

/**
 * Per-command since-boot dispatch count. Powers the dashboard's
 * "Calls" column.
 */
export function getCommandCounts(): Record<string, number> {
  return Object.fromEntries(getCounts().entries());
}

export function getCommandHistory(n = 50): CommandHistoryEntry[] {
  return getEntries().slice(-n).reverse();
}

export function getCommandHistoryStats(): {
  total: number;
  ok: number;
  denied: number;
  unknown: number;
  error: number;
  topCommands: Array<{ name: string; count: number }>;
} {
  const entries = getEntries();
  const outcomes = { ok: 0, denied: 0, unknown: 0, error: 0 };
  for (const e of entries) outcomes[e.outcome] += 1;
  // Use the permanent since-boot counter for top commands so it stays
  // accurate beyond the 200-entry ring.
  const topCommands = [...getCounts().entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  return { total: entries.length, ...outcomes, topCommands };
}
