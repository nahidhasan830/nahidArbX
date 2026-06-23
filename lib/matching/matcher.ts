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

export async function matchEvents(
  allEvents: NormalizedEvent[],
): Promise<NormalizedEvent[]> {
  resetSyncCounters();

  await preResolveAll(allEvents);

  const timeGroups = groupByTime(allEvents);

  const currentKeys = new Set(allEvents.map((e) => getEventStableKey(e)));
  const currentEventIds = new Set(allEvents.map((e) => e.id));
  pruneResolvedCache(currentEventIds);

  const preNormalized = preNormalizeAll(allEvents);

  const matched: NormalizedEvent[] = [];
  const usedIds = new Set<string>();

  let totalMatches = 0;
  let totalNearMatches = 0;

  for (const [, events] of timeGroups) {
    const providers = new Set<Provider>();
    for (const e of events) {
      for (const p of Object.keys(e.providers) as Provider[]) {
        providers.add(p);
      }
    }

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

    const groupResult = await findMatchesInGroup(events, preNormalized);
    totalMatches += groupResult.matches.length;
    totalNearMatches += groupResult.nearMatchCount;

    for (const match of groupResult.matches) {
      const merged = mergeEvents(match.events, "tier1-auto", match.score);
      matched.push(merged);
      for (const e of match.events) {
        usedIds.add(e.id);
      }
      cacheMatchGroup(match.events, merged.id);
    }

    for (const e of events) {
      if (!usedIds.has(e.id)) {
        matched.push(e);
        usedIds.add(e.id);
        cacheUnmatchedEvent(e);
      }
    }
  }

  pruneCache(currentKeys);


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
    if (!eventA || !eventB) continue;
    if (eventA.id === eventB.id) continue;

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

function tryRebuildBucket(
  events: NormalizedEvent[],
  currentKeys: Set<string>,
): NormalizedEvent[] | null {
  if (!events.every((e) => isEventCached(e))) return null;

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

  for (const [, groupEvents] of eventsByGroup) {
    const key = getEventStableKey(groupEvents[0]);
    const cached = getCachedGroupForEvent(key)!;

    if (cached.memberKeys.length !== groupEvents.length) return null;

    for (const mk of cached.memberKeys) {
      if (!currentKeys.has(mk)) return null;
    }
  }

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

function getTimeKey(date: Date): string {
  const rounded = Math.floor(date.getTime() / TIME_BUCKET_MS) * TIME_BUCKET_MS;
  return new Date(rounded).toISOString();
}

interface GroupMatchResult {
  matches: MatchResult[];
  nearMatchCount: number;
}

async function findMatchesInGroup(
  events: NormalizedEvent[],
  preNormalized: Map<string, PreNormalizedNames>,
): Promise<GroupMatchResult> {
  const matchingConfig = getMatchingConfig();
  const matches: MatchResult[] = [];
  const used = new Set<string>();
  let nearMatchCount = 0;

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

      const eventProviders = Object.keys(sorted[j].providers);
      const hasSameProvider = eventProviders.some((p) =>
        providersInGroup.has(p),
      );
      if (hasSameProvider) continue;

      const breakdown = computeDetailedScore(
        sorted[i],
        sorted[j],
        preNormalized.get(sorted[i].id),
        preNormalized.get(sorted[j].id),
      );

      if (breakdown.bestOrientation === "swapped") {
        continue;
      }

      const score = breakdown.finalScore;

      if (
        matchingConfig.competitionHardGate.enabled &&
        breakdown.competitionScore <
          matchingConfig.competitionHardGate.minCompetitionScore
      ) {
        continue;
      }

      if (score >= MATCH_THRESHOLD) {
        const negativeMatch = getSuspiciousStore().checkNegativeEventExample(
          sorted[i].homeTeam,
          sorted[i].awayTeam,
          sorted[j].homeTeam,
          sorted[j].awayTeam,
        );

        if (negativeMatch) {
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

        if (matchingConfig.aliasHarvesting.enabled) {
          const normI = preNormalized.get(sorted[i].id);
          const normJ = preNormalized.get(sorted[j].id);
          if (normI && normJ) {
            void harvestMatchPair(sorted[i], sorted[j], normI, normJ, score);
          }
        }
      } else if (isNearMatch(score)) {
        const nm = await detectAndStoreNearMatch(
          sorted[i],
          sorted[j],
          breakdown,
        );
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
  const pinnacleEvent = events.find((e) => e.providers.pinnacle);
  const base = pinnacleEvent || events[0];

  const mergedProviders = events.reduce(
    (acc, e) => ({ ...acc, ...e.providers }),
    {} as NormalizedEvent["providers"],
  );

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
