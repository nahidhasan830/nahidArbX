/**
 * Datetime helpers used across the app.
 *
 * Keep timestamps as absolute instants and let the runtime/browser resolve
 * them in the active locale timezone.
 */

/**
 * Parse an ISO timestamp and return a Date object.
 * Safe for both client and server.
 */
export function parseUtcIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d;
}
