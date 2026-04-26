/**
 * In-memory ring buffers for `/notifs` and `/errors`.
 *
 * Lightweight, process-local, no DB. We only keep the last N entries
 * each — the bot is a phone-friendly snapshot, not an audit log. The
 * buffers are pinned to globalThis so HMR doesn't fragment them across
 * module-context copies.
 */

import { singleton } from "@/lib/util/singleton";

export interface RecentNotificationEntry {
  at: string;
  type: string;
  summary: string;
}

export interface RecentErrorEntry {
  at: string;
  source: string;
  message: string;
}

interface Buffers {
  notifs: RecentNotificationEntry[];
  errors: RecentErrorEntry[];
}

const NOTIFS_MAX = 50;
const ERRORS_MAX = 50;

const buf = singleton<Buffers>("telegram:recent", () => ({
  notifs: [],
  errors: [],
}));

export function recordNotification(entry: RecentNotificationEntry): void {
  buf.notifs.push(entry);
  if (buf.notifs.length > NOTIFS_MAX) {
    buf.notifs.splice(0, buf.notifs.length - NOTIFS_MAX);
  }
}

export function recordError(entry: RecentErrorEntry): void {
  buf.errors.push(entry);
  if (buf.errors.length > ERRORS_MAX) {
    buf.errors.splice(0, buf.errors.length - ERRORS_MAX);
  }
}

export function getRecentNotifications(n = 10): RecentNotificationEntry[] {
  return buf.notifs.slice(-n).reverse();
}

export function getRecentErrors(n = 10): RecentErrorEntry[] {
  return buf.errors.slice(-n).reverse();
}
