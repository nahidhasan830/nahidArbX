/**
 * Common Formatting Helpers
 *
 * Shared utility functions for formatting dates, numbers, and percentages
 * used across UI components, Telegram messages, and API responses.
 */

/**
 * Format an ISO date string to a human-readable date/time label.
 * e.g., "2024-01-15T15:00:00Z" → "Today 15:00" or "Jan 15 15:00"
 */
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = d.toDateString() === tomorrow.toDateString();
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) return `Today ${time}`;
  if (isTomorrow) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "2-digit" })} ${time}`;
}

/**
 * Format elapsed time since `iso` as a terse badge: "now", "Nm", "Nh", "Nd".
 * Intended for table cells like "Seen" / "Settled" where a one-glance age
 * matters more than precision. For future-facing "in Xm" use `fmtRelative`.
 */
export function fmtSeen(iso: string): string {
  const d = new Date(iso);
  const diffMin = (Date.now() - d.getTime()) / 60000;
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${Math.floor(diffMin)}m`;
  if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h`;
  return `${Math.floor(diffMin / 1440)}d`;
}

/**
 * Format a relative time duration.
 * e.g., 60000ms → "1m", 3600000ms → "1h"
 */
export function fmtRelative(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Math.abs(ms) < 60_000) return "just now";
  if (ms > 0) return `in ${durationLabel(ms)}`;
  return `${durationLabel(-ms)} ago`;
}

export function durationLabel(ms: number): string {
  const mins = Math.round(Math.abs(ms) / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  const days = Math.floor(hours / 24);
  const hrem = hours % 24;
  return hrem === 0 ? `${days}d` : `${days}d ${hrem}h`;
}

/**
 * Format money/currency values.
 * e.g., 1000.50 → "৳ 1,000.50"
 */
export function fmtMoney(amount: number, currency: string = "BDT"): string {
  const symbol = currency === "BDT" ? "৳" : currency;
  return `${symbol} ${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Format a signed percentage.
 * e.g., 2.5 → "+2.50%", -1.2 → "−1.20%"
 */
export function fmtSignedPct(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}
