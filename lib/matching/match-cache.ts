/**
 * Event Matching Cache
 *
 * Caches match results between fixture syncs so that only NEW events
 * need expensive O(n²) string similarity comparisons.
 *
 * Cache key: provider:eventId (stable across syncs)
 * Fingerprint: homeTeam|awayTeam|competition|startTime (change detection)
 *
 * On each sync:
 * - Time buckets with ALL events cached & unchanged → rebuild from cache (skip matching)
 * - Time buckets with any new/changed events → full matching, then cache results
 * - Stale entries pruned after each sync
 */

import type { NormalizedEvent } from "../types";
import { logger } from "../shared/logger";

interface CachedGroupInfo {
  groupId: string;
  memberKeys: string[]; // sorted stable keys of all group members
}

// event stable key → cached group assignment
const cache = new Map<string, CachedGroupInfo>();
// event stable key → fingerprint (for change detection)
const fingerprints = new Map<string, string>();

// Stats
let bucketsSkipped = 0;
let bucketsProcessed = 0;

/**
 * Stable key for an event based on its provider identity.
 * Single-provider events (from adapters) use "{provider}:{eventId}".
 */
export function getEventStableKey(event: NormalizedEvent): string {
  const entries = Object.entries(event.providers);
  if (entries.length === 1) {
    const [provider, info] = entries[0];
    return `${provider}:${info!.eventId}`;
  }
  // Multi-provider (shouldn't happen at matchEvents input)
  return entries
    .map(([p, info]) => `${p}:${info!.eventId}`)
    .sort()
    .join("|");
}

/**
 * Fingerprint captures the fields that affect matching.
 * If any of these change, the event must be re-matched.
 */
function getFingerprint(event: NormalizedEvent): string {
  return `${event.homeTeam}|${event.awayTeam}|${event.competition}|${event.startTime.getTime()}`;
}

/**
 * Check if an event is cached and unchanged since last sync.
 */
export function isEventCached(event: NormalizedEvent): boolean {
  const key = getEventStableKey(event);
  const cachedFp = fingerprints.get(key);
  if (!cachedFp) return false;
  return cachedFp === getFingerprint(event);
}

/**
 * Get the cached group info for an event key.
 */
export function getCachedGroupForEvent(
  eventKey: string,
): CachedGroupInfo | undefined {
  return cache.get(eventKey);
}

/**
 * Cache a matched group of events.
 */
export function cacheMatchGroup(
  events: NormalizedEvent[],
  groupId: string,
): void {
  const memberKeys = events.map((e) => getEventStableKey(e)).sort();
  for (const event of events) {
    const key = getEventStableKey(event);
    cache.set(key, { groupId, memberKeys });
    fingerprints.set(key, getFingerprint(event));
  }
}

/**
 * Cache a single unmatched event.
 */
export function cacheUnmatchedEvent(event: NormalizedEvent): void {
  const key = getEventStableKey(event);
  cache.set(key, { groupId: event.id, memberKeys: [key] });
  fingerprints.set(key, getFingerprint(event));
}

/**
 * Remove cache entries for events no longer present.
 */
export function pruneCache(currentKeys: Set<string>): void {
  let pruned = 0;
  for (const key of [...cache.keys()]) {
    if (!currentKeys.has(key)) {
      cache.delete(key);
      fingerprints.delete(key);
      pruned++;
    }
  }
  if (pruned > 0) {
    logger.debug("MatchCache", `Pruned ${pruned} stale entries`);
  }
}

/**
 * Full cache reset (called when aliases change or on demand).
 */
export function resetMatchCache(): void {
  cache.clear();
  fingerprints.clear();
  bucketsSkipped = 0;
  bucketsProcessed = 0;
  logger.debug("MatchCache", "Cache reset");
}

/**
 * Record a bucket skip (served from cache).
 */
export function recordBucketSkip(): void {
  bucketsSkipped++;
}

/**
 * Record a bucket that needed full processing.
 */
export function recordBucketProcess(): void {
  bucketsProcessed++;
}

/**
 * Get cache statistics for diagnostics.
 */
export function getMatchCacheStats() {
  const totalBuckets = bucketsSkipped + bucketsProcessed;
  return {
    cachedEvents: cache.size,
    bucketsSkipped,
    bucketsProcessed,
    bucketSkipRate:
      totalBuckets > 0
        ? ((bucketsSkipped / totalBuckets) * 100).toFixed(1) + "%"
        : "N/A",
  };
}

/**
 * Reset per-sync counters (call at start of each matchEvents invocation).
 */
export function resetSyncCounters(): void {
  bucketsSkipped = 0;
  bucketsProcessed = 0;
}
