import type { NormalizedEvent, Provider } from "../types";
import { MATCH_THRESHOLD, TIME_BUCKET_MS } from "../shared/constants";
import { logger } from "../shared/logger";
import {
  computeDetailedScore,
  detectAndStoreNearMatch,
  isNearMatch,
} from "./diagnostics/analyzer";
import { getSuspiciousStore } from "./diagnostics/suspicious-store";
import {
  getEventStableKey,
  isEventCached,
  getCachedGroupForEvent,
  cacheMatchGroup,
  cacheUnmatchedEvent,
  pruneCache,
  recordBucketSkip,
  recordBucketProcess,
  resetSyncCounters,
  getMatchCacheStats,
} from "./match-cache";
import {
  preNormalizeAll,
  preResolveAll,
  pruneResolvedCache,
  type PreNormalizedNames,
} from "./normalize";
import { getMatchingConfig } from "./config";
import { harvestMatchPair } from "./entities/match-harvester";
import { listDecisions, AI_AUTONOMOUS_THRESHOLD } from "./ai-decision-cache";
import { locateEventBySide } from "./locate";

export interface MatchResult {
  events: NormalizedEvent[];
  score: number;
}

/**
 * Tier 1: Fast event matching across providers using exact-time grouping.
 *
 * Algorithm:
 * 1. Group events by exact start time (1-minute buckets)
 * 2. Within each group, compare events from different providers
 * 3. Score: 0.7*teamSimilarity + 0.3*competitionSimilarity (time is implicit)
 * 4. Competition hard gate: reject if compScore < 0.3
 * 5. Merge matched events into single NormalizedEvent with multiple providers
 * 6. Unmatched events are handled by the Background Deep Matcher (Tier 2)
 *
 * Pre-resolves every event surface against the entity-resolution store
 * before scoring, so the per-comparison hot path stays sync.
 */
export async function matchEvents(
  allEvents: NormalizedEvent[],
): Promise<NormalizedEvent[]> {
  resetSyncCounters();

  // 0. Pre-resolve names against the entity store (Postgres-backed).
  //    Async; runs once per sync. Failures degrade to plain normalize.
  await preResolveAll(allEvents);

  // 1. Group by rounded start time
  const timeGroups = groupByTime(allEvents);

  // Track all current event keys for cache pruning
  const currentKeys = new Set(allEvents.map((e) => getEventStableKey(e)));
  const currentEventIds = new Set(allEvents.map((e) => e.id));
  pruneResolvedCache(currentEventIds);

  // Pre-normalize all event names once (avoids per-comparison normalization)
  const preNormalized = preNormalizeAll(allEvents);

  // 2. Match within each group (with cache optimization)
  const matched: NormalizedEvent[] = [];
  const usedIds = new Set<string>();

  let totalMatches = 0;
  let totalNearMatches = 0;

  for (const [, events] of timeGroups) {
    // Get unique providers in this time bucket
    const providers = new Set<Provider>();
    for (const e of events) {
      for (const p of Object.keys(e.providers) as Provider[]) {
        providers.add(p);
      }
    }

    // Skip groups with only one provider (no cross-provider matching possible)
    if (providers.size < 2) {
      for (const e of events) {
        if (!usedIds.has(e.id)) {
          matched.push(e);
          usedIds.add(e.id);
          cacheUnmatchedEvent(e);
        }
      }
      continue;
    }

    // Try to rebuild this bucket from cache (all events cached & unchanged)
    const cachedResult = tryRebuildBucket(events, currentKeys);
    if (cachedResult) {
      recordBucketSkip();
      for (const event of cachedResult) {
        if (!usedIds.has(event.id)) {
          matched.push(event);
          usedIds.add(event.id);
        }
      }
      totalMatches += cachedResult.filter(
        (e) => Object.keys(e.providers).length > 1,
      ).length;
      continue;
    }

    recordBucketProcess();

    // Full matching for this bucket (with pre-normalized names)
    const groupResult = findMatchesInGroup(events, preNormalized);
    totalMatches += groupResult.matches.length;
    totalNearMatches += groupResult.nearMatchCount;

    for (const match of groupResult.matches) {
      // Merge matched events into one
      const merged = mergeEvents(match.events, "tier1-auto", match.score);
      matched.push(merged);
      for (const e of match.events) {
        usedIds.add(e.id);
      }
      // Cache this match group
      cacheMatchGroup(match.events, merged.id);
    }

    // Add unmatched events from this group
    for (const e of events) {
      if (!usedIds.has(e.id)) {
        matched.push(e);
        usedIds.add(e.id);
        cacheUnmatchedEvent(e);
      }
    }
  }

  // Prune cache entries for events no longer present
  pruneCache(currentKeys);

  // Note: alias promotion runs inline-but-fire-and-forget inside
  // recordObservation() → autoResolve() (lib/matching/entities/auto-resolve.ts).
  // Verdicts land ~150–250 ms after the sync returns; new aliases become
  // effective on the next sync tick.

  // Reconcile cached SAME verdicts that didn't merge on their original sync
  // (e.g. provider event IDs rotated between AI analysis and the user's
  // click, so `autoMergeOnAISame` returned "events-missing"). On this pass
  // the events are back with fresh IDs — snapshot-based locate should find
  // them and we can finish the merge that the AI already blessed.
  const reconciled = reconcileFromDecisionCache(matched);

  const cacheStats = getMatchCacheStats();
  const nearMatchMsg =
    totalNearMatches > 0 ? `, ${totalNearMatches} near-matches` : "";
  const cacheMsg = `, ${cacheStats.bucketsSkipped} buckets cached (${cacheStats.bucketSkipRate} skip rate)`;
  const reconcileMsg =
    reconciled > 0 ? `, ${reconciled} reconciled from cache` : "";
  logger.info(
    "Matcher",
    `${timeGroups.size} time groups, ${totalMatches} matches${nearMatchMsg}${cacheMsg}${reconcileMsg}`,
  );

  return matched;
}

/**
 * Walk the decision cache and merge any pair that has an AI SAME verdict
 * ≥ threshold (or human approval) but is still sitting as two separate
 * events in the freshly-matched list. Uses the snapshot stored on each
 * decision to locate the sides by provider + aliased teams + minute.
 *
 * Mutates `matched` in place. Returns the count of merges performed.
 */
function reconcileFromDecisionCache(matched: NormalizedEvent[]): number {
  let merges = 0;
  for (const d of listDecisions()) {
    if (!d.snapshot) continue;
    const shouldMerge =
      (d.decidedBy === "human" && d.verdict === "SAME") ||
      (d.decidedBy === "gemini" &&
        d.verdict === "SAME" &&
        d.confidence >= AI_AUTONOMOUS_THRESHOLD);
    if (!shouldMerge) continue;

    const eventA = locateEventBySide(d.snapshot.eventA, matched);
    const eventB = locateEventBySide(d.snapshot.eventB, matched);
    if (!eventA || !eventB) continue; // events not in this sync's data
    if (eventA.id === eventB.id) continue; // already merged in the same entity

    // Don't reconcile across multi-provider events — if one side is already
    // a multi-provider merge the matcher knows best, leave it alone.
    if (Object.keys(eventA.providers).length > 1) continue;
    if (Object.keys(eventB.providers).length > 1) continue;

    const merged: NormalizedEvent = {
      ...eventA,
      providers: { ...eventA.providers, ...eventB.providers },
      matchSource: d.decidedBy === "human" ? "manual" : "ai-confirmed",
      matchConfidence: d.confidence,
    };
    const idxA = matched.indexOf(eventA);
    const idxB = matched.indexOf(eventB);
    // Replace the lower index with merged, remove the other. indexOf is O(N)
    // but listDecisions tends to be small — if it grows, swap to a map.
    if (idxA < idxB) {
      matched.splice(idxB, 1);
      matched[idxA] = merged;
    } else {
      matched.splice(idxA, 1);
      matched[idxB] = merged;
    }
    merges++;
  }
  return merges;
}

/**
 * Try to rebuild a time bucket's match results from cache.
 *
 * Returns merged events if ALL events in the bucket are cached, unchanged,
 * and all group members are present. Returns null if any event is new/changed
 * or if group integrity is broken (member moved to different bucket).
 */
function tryRebuildBucket(
  events: NormalizedEvent[],
  currentKeys: Set<string>,
): NormalizedEvent[] | null {
  // All events must be cached and unchanged
  if (!events.every((e) => isEventCached(e))) return null;

  // Group events by their cached group ID
  const eventsByGroup = new Map<string, NormalizedEvent[]>();
  for (const event of events) {
    const key = getEventStableKey(event);
    const cached = getCachedGroupForEvent(key);
    if (!cached) return null;

    const group = eventsByGroup.get(cached.groupId);
    if (group) {
      group.push(event);
    } else {
      eventsByGroup.set(cached.groupId, [event]);
    }
  }

  // Verify group integrity: all members of each group must be present
  for (const [, groupEvents] of eventsByGroup) {
    const key = getEventStableKey(groupEvents[0]);
    const cached = getCachedGroupForEvent(key)!;

    // Check member count matches (detects members that moved to other buckets)
    if (cached.memberKeys.length !== groupEvents.length) return null;

    // Check all members still exist in current sync data
    for (const mk of cached.memberKeys) {
      if (!currentKeys.has(mk)) return null;
    }
  }

  // Rebuild merged events from cache
  const result: NormalizedEvent[] = [];
  for (const [, groupEvents] of eventsByGroup) {
    if (groupEvents.length > 1) {
      result.push(mergeEvents(groupEvents));
    } else {
      result.push(groupEvents[0]);
    }
  }

  return result;
}

function groupByTime(
  events: NormalizedEvent[],
): Map<string, NormalizedEvent[]> {
  const groups = new Map<string, NormalizedEvent[]>();

  for (const event of events) {
    const key = getTimeKey(event.startTime);
    const group = groups.get(key);
    if (group) {
      group.push(event);
    } else {
      groups.set(key, [event]);
    }
  }

  return groups;
}

/**
 * Get time bucket key for event grouping.
 * Rounds to nearest minute (TIME_BUCKET_MS = 60s) for exact-time matching.
 * Events that start at the same minute are grouped together.
 * Timezone-displaced events are handled by the background deep matcher (Tier 2).
 */
function getTimeKey(date: Date): string {
  const rounded = Math.floor(date.getTime() / TIME_BUCKET_MS) * TIME_BUCKET_MS;
  return new Date(rounded).toISOString();
}

interface GroupMatchResult {
  matches: MatchResult[];
  nearMatchCount: number;
}

function findMatchesInGroup(
  events: NormalizedEvent[],
  preNormalized: Map<string, PreNormalizedNames>,
): GroupMatchResult {
  const matchingConfig = getMatchingConfig();
  const matches: MatchResult[] = [];
  const used = new Set<string>();
  let nearMatchCount = 0;

  // Sort by provider for consistent comparison order
  const sorted = [...events].sort((a, b) => {
    const provA = Object.keys(a.providers)[0] || "";
    const provB = Object.keys(b.providers)[0] || "";
    return provA.localeCompare(provB);
  });

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(sorted[i].id)) continue;

    const matchGroup: NormalizedEvent[] = [sorted[i]];
    const providersInGroup = new Set(Object.keys(sorted[i].providers));

    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(sorted[j].id)) continue;

      // Skip if same provider already in match group
      const eventProviders = Object.keys(sorted[j].providers);
      const hasSameProvider = eventProviders.some((p) =>
        providersInGroup.has(p),
      );
      if (hasSameProvider) continue;

      // Use detailed score computation (with pre-normalized names)
      const breakdown = computeDetailedScore(
        sorted[i],
        sorted[j],
        preNormalized.get(sorted[i].id),
        preNormalized.get(sorted[j].id),
      );
      const score = breakdown.finalScore;

      // Competition hard gate: reject if competitions are wildly different
      // (prevents same-team-different-tournament false positives)
      if (
        matchingConfig.competitionHardGate.enabled &&
        breakdown.competitionScore <
          matchingConfig.competitionHardGate.minCompetitionScore
      ) {
        continue;
      }

      if (score >= MATCH_THRESHOLD) {
        // Check if this pair is a known wrong match (negative example)
        const negativeMatch = getSuspiciousStore().checkNegativeEventExample(
          sorted[i].homeTeam,
          sorted[i].awayTeam,
          sorted[j].homeTeam,
          sorted[j].awayTeam,
        );

        if (negativeMatch) {
          // Skip - this is a known wrong pairing
          logger.info(
            "Matcher",
            `Skipping match due to negative example: ${sorted[i].homeTeam} vs ${sorted[j].homeTeam}`,
          );
          continue;
        }

        matchGroup.push(sorted[j]);
        used.add(sorted[j].id);
        for (const p of eventProviders) {
          providersInGroup.add(p);
        }

        // Record observations into the entity-resolution store.
        // recordObservation() fires autoResolve() in the background;
        // verdicts land asynchronously and become effective on the next
        // sync tick. No staging file, no occurrence-counter ratchet,
        // no global namespace.
        if (matchingConfig.aliasHarvesting.enabled) {
          const normI = preNormalized.get(sorted[i].id);
          const normJ = preNormalized.get(sorted[j].id);
          if (normI && normJ) {
            void harvestMatchPair(sorted[i], sorted[j], normI, normJ, score);
          }
        }
      } else if (isNearMatch(score)) {
        // Store near-match for later review
        const nm = detectAndStoreNearMatch(sorted[i], sorted[j], breakdown);
        if (nm) nearMatchCount++;
      }
    }

    if (matchGroup.length > 1) {
      used.add(sorted[i].id);
      const breakdown = computeDetailedScore(
        matchGroup[0],
        matchGroup[1],
        preNormalized.get(matchGroup[0].id),
        preNormalized.get(matchGroup[1].id),
      );
      matches.push({ events: matchGroup, score: breakdown.finalScore });
    }
  }

  return { matches, nearMatchCount };
}

function mergeEvents(
  events: NormalizedEvent[],
  matchSource?: import("./config").MatchSource,
  matchConfidence?: number,
): NormalizedEvent {
  // Prioritize Pinnacle as source of truth for team names (has explicit HOME/AWAY)
  // Fall back to first event if Pinnacle not present
  const pinnacleEvent = events.find((e) => e.providers.pinnacle);
  const base = pinnacleEvent || events[0];

  // Merge all provider info
  const mergedProviders = events.reduce(
    (acc, e) => ({ ...acc, ...e.providers }),
    {} as NormalizedEvent["providers"],
  );

  // Create merged event ID.
  // Sort provider IDs so the same physical match always yields the same
  // mergedId regardless of the order events were merged in.
  const mergedId = `matched-${events
    .map((e) => e.id)
    .sort()
    .join("-")}`;

  return {
    ...base,
    id: mergedId,
    providers: mergedProviders,
    matchSource: matchSource ?? "tier1-auto",
    matchConfidence: matchConfidence
      ? Math.round(matchConfidence * 100)
      : undefined,
  };
}
