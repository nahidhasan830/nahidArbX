import { compareTwoStrings } from "string-similarity";
import type { NormalizedEvent, Provider } from "../types";

const MATCH_THRESHOLD = 0.85;
const TIME_BUCKET_MS = 5 * 60 * 1000; // 5 minutes

export interface MatchResult {
  events: NormalizedEvent[];
  score: number;
}

/**
 * Match events across providers using time-first grouping.
 *
 * Algorithm:
 * 1. Group events by rounded start time (5 min buckets)
 * 2. Within each bucket, compare events from different providers
 * 3. Merge matched events into single NormalizedEvent with multiple providers
 */
export function matchEvents(allEvents: NormalizedEvent[]): NormalizedEvent[] {
  // 1. Group by rounded start time
  const timeGroups = groupByTime(allEvents);

  // 2. Match within each group
  const matched: NormalizedEvent[] = [];
  const usedIds = new Set<string>();

  let totalMatches = 0;

  for (const [timeKey, events] of timeGroups) {
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
        }
      }
      continue;
    }

    // Find matches within this time group
    const groupMatches = findMatchesInGroup(events);
    totalMatches += groupMatches.length;

    for (const match of groupMatches) {
      // Merge matched events into one
      const merged = mergeEvents(match.events);
      matched.push(merged);
      for (const e of match.events) {
        usedIds.add(e.id);
      }
    }

    // Add unmatched events from this group
    for (const e of events) {
      if (!usedIds.has(e.id)) {
        matched.push(e);
        usedIds.add(e.id);
      }
    }
  }

  console.log(
    `[Matcher] ${timeGroups.size} time groups, ${totalMatches} matches found`
  );

  return matched;
}

function groupByTime(
  events: NormalizedEvent[]
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
  const rounded =
    Math.floor(date.getTime() / TIME_BUCKET_MS) * TIME_BUCKET_MS;
  return new Date(rounded).toISOString();
}

function findMatchesInGroup(events: NormalizedEvent[]): MatchResult[] {
  const matches: MatchResult[] = [];
  const used = new Set<string>();

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
      const hasSameProvider = eventProviders.some((p) => providersInGroup.has(p));
      if (hasSameProvider) continue;

      const score = computeScore(sorted[i], sorted[j]);
      if (score >= MATCH_THRESHOLD) {
        matchGroup.push(sorted[j]);
        used.add(sorted[j].id);
        for (const p of eventProviders) {
          providersInGroup.add(p);
        }
      }
    }

    if (matchGroup.length > 1) {
      used.add(sorted[i].id);
      const avgScore =
        matchGroup.length > 1
          ? computeScore(matchGroup[0], matchGroup[1])
          : MATCH_THRESHOLD;
      matches.push({ events: matchGroup, score: avgScore });
    }
  }

  return matches;
}

function computeScore(a: NormalizedEvent, b: NormalizedEvent): number {
  const homeA = normalize(a.homeTeam);
  const homeB = normalize(b.homeTeam);
  const awayA = normalize(a.awayTeam);
  const awayB = normalize(b.awayTeam);

  // Normal orientation: homeA vs homeB, awayA vs awayB
  const normalTeamScore =
    (compareTwoStrings(homeA, homeB) + compareTwoStrings(awayA, awayB)) / 2;

  // Swapped orientation: homeA vs awayB, awayA vs homeB
  const swappedTeamScore =
    (compareTwoStrings(homeA, awayB) + compareTwoStrings(awayA, homeB)) / 2;

  const teamScore = Math.max(normalTeamScore, swappedTeamScore);

  // Competition similarity
  const compScore = compareTwoStrings(
    normalize(a.competition),
    normalize(b.competition)
  );

  // Time score (already in same bucket, so typically high)
  const timeDiff = Math.abs(a.startTime.getTime() - b.startTime.getTime());
  const timeScore = Math.max(0, 1 - timeDiff / (2 * 60 * 60 * 1000));

  // Weighted score per CLAUDE.md spec
  return 0.6 * teamScore + 0.2 * compScore + 0.2 * timeScore;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
    .replace(/[^a-z0-9\s]/g, "") // Remove punctuation
    .trim();
}

function mergeEvents(events: NormalizedEvent[]): NormalizedEvent {
  const base = events[0];

  // Merge all provider info
  const mergedProviders = events.reduce(
    (acc, e) => ({ ...acc, ...e.providers }),
    {} as NormalizedEvent["providers"]
  );

  // Create merged event ID
  const mergedId = `matched-${events.map((e) => e.id).join("-")}`;

  return {
    ...base,
    id: mergedId,
    providers: mergedProviders,
  };
}
