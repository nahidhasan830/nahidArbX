/**
 * Response Cache (Version-Based)
 *
 * Caches the dashboard API response and only rebuilds when the
 * atoms store version changes (actual odds value changes).
 *
 * Also provides ETag support for HTTP 304 responses.
 */

import { getStoreVersion } from "../atoms/store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedResponse: Record<string, any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedResponseAll: Record<string, any> | null = null;
let cachedAtVersion = -1;

/**
 * Get cached response. Returns null if store has changed since last cache.
 */
export function getCachedResponse(
  includeAll = false,
): Record<string, unknown> | null {
  const currentVersion = getStoreVersion();

  // Cache still valid — store hasn't changed
  if (cachedAtVersion === currentVersion) {
    return includeAll ? cachedResponseAll : cachedResponse;
  }

  // Store changed — invalidate
  return null;
}

export function setCachedResponse(
  data: Record<string, unknown>,
  includeAll = false,
): void {
  cachedAtVersion = getStoreVersion();
  if (includeAll) {
    cachedResponseAll = data;
  } else {
    cachedResponse = data;
  }
}

/**
 * Force invalidation (e.g., after fixture sync changes event structure).
 */
export function invalidateResponseCache(): void {
  cachedAtVersion = -1;
  cachedResponse = null;
  cachedResponseAll = null;
}

// ============================================
// ETag Helpers
// ============================================

/**
 * Generate an ETag from the current store version.
 * Weak ETag — the response body may vary (e.g., providerStatus is always fresh).
 */
export function getResponseETag(): string {
  return `W/"v${getStoreVersion()}"`;
}

/**
 * Check If-None-Match header against current ETag.
 * Returns a 304 Response if matched, or null to continue with full response.
 */
export function checkETag(request: Request): Response | null {
  const ifNoneMatch = request.headers.get("if-none-match");
  if (!ifNoneMatch) return null;

  const currentETag = getResponseETag();
  const normalize = (t: string) => t.trim().replace(/^W\//, "");

  // Handle comma-separated ETags
  const clientTags = ifNoneMatch.split(",").map((t) => normalize(t));
  if (clientTags.includes(normalize(currentETag))) {
    return new Response(null, {
      status: 304,
      headers: { ETag: currentETag },
    });
  }

  return null;
}
