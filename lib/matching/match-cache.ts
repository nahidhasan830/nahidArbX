
import type { NormalizedEvent } from "../types";
import { logger } from "../shared/logger";

interface CachedGroupInfo {
  groupId: string;
  memberKeys: string[];
}

const cache = new Map<string, CachedGroupInfo>();
const fingerprints = new Map<string, string>();

let bucketsSkipped = 0;
let bucketsProcessed = 0;

export function getEventStableKey(event: NormalizedEvent): string {
  const entries = Object.entries(event.providers);
  if (entries.length === 1) {
    const [provider, info] = entries[0];
    return `${provider}:${info!.eventId}`;
  }
  return entries
    .map(([p, info]) => `${p}:${info!.eventId}`)
    .sort()
    .join("|");
}

function getFingerprint(event: NormalizedEvent): string {
  return `${event.homeTeam}|${event.awayTeam}|${event.competition}|${event.startTime.getTime()}`;
}

export function isEventCached(event: NormalizedEvent): boolean {
  const key = getEventStableKey(event);
  const cachedFp = fingerprints.get(key);
  if (!cachedFp) return false;
  return cachedFp === getFingerprint(event);
}

export function getCachedGroupForEvent(
  eventKey: string,
): CachedGroupInfo | undefined {
  return cache.get(eventKey);
}

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

export function cacheUnmatchedEvent(event: NormalizedEvent): void {
  const key = getEventStableKey(event);
  cache.set(key, { groupId: event.id, memberKeys: [key] });
  fingerprints.set(key, getFingerprint(event));
}

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

export function resetMatchCache(): void {
  cache.clear();
  fingerprints.clear();
  bucketsSkipped = 0;
  bucketsProcessed = 0;
  logger.debug("MatchCache", "Cache reset");
}

export function recordBucketSkip(): void {
  bucketsSkipped++;
}

export function recordBucketProcess(): void {
  bucketsProcessed++;
}

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

export function resetSyncCounters(): void {
  bucketsSkipped = 0;
  bucketsProcessed = 0;
}
