/**
 * Timezone-aware Datetime Formatting
 *
 * All date/time display logic should use Asia/Dhaka (BDT) regardless of
 * where the user or server is located. This ensures consistent "in Xm"
 * and KO-time labels for Bangladeshi bettors.
 *
 * The engine runs on a BD VPS — backend timestamps are UTC. Frontend
 * display must convert to Asia/Dhaka.
 */

export const DhakaTimezone = "Asia/Dhaka";

/**
 * Parse an ISO timestamp and return a Date object.
 * Safe for both client and server — parses UTC input.
 */
export function parseUtcIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d;
}

/**
 * Format a Date to "HH:mm" in Asia/Dhaka.
 */
export function fmtDhkTime(d: Date): string {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: DhakaTimezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return f.format(d);
}

/**
 * Format a Date to "YYYY-MM-DD" in Asia/Dhaka.
 */
export function fmtDhkDate(d: Date): string {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: DhakaTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return f.format(d);
}

/**
 * Format a Date to "DD Mon HH:mm" in Asia/Dhaka.
 * e.g., "19 May 20:30"
 */
export function fmtDhkDateTime(d: Date): string {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: DhakaTimezone,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return f.format(d);
}

/**
 * Get the current Date interpreted in Asia/Dhaka.
 */
export function nowDhk(): Date {
  // Offset: BDT = UTC + 6h. At any moment, "now in Dhaka" = now − 6h UTC.
  return new Date(Date.now() + 6 * 3600 * 1000);
}