/**
 * Shared name normalization for the matching pipeline.
 *
 * Delegates to the entity-resolution module for the actual normalize
 * rules + the resolver lookup. This file remains the single import for
 * `lib/matching/matcher.ts` and the diagnostics analyzer; it's a thin
 * adapter over the new entity-resolution layer.
 *
 * Note: alias resolution is now async (Postgres-backed). Pre-normalization
 * stays sync in the hot path by deferring the resolver lookup to a batch
 * pre-pass that fills the cache; subsequent per-event lookups hit the
 * 30s LRU and return synchronously through `applyTeamAliasSync` /
 * `applyCompetitionAliasSync` (which fall back to plain normalize when
 * the cache is cold).
 */

import type { NormalizedEvent } from "../types";
import {
  normalize as entityNormalize,
  normalizeCompetition as entityNormalizeCompetition,
} from "./entities/normalize";
import {
  resolveCompetitionSurface,
  resolveTeamSurface,
} from "./entities/resolver";

export const COUNTRY_ADJECTIVE_MAP: Record<string, string> = {
  english: "england",
  british: "england",
  scottish: "scotland",
  welsh: "wales",
  irish: "ireland",
  spanish: "spain",
  german: "germany",
  french: "france",
  italian: "italy",
  dutch: "netherlands",
  portuguese: "portugal",
  belgian: "belgium",
  austrian: "austria",
  swiss: "switzerland",
  turkish: "turkey",
  greek: "greece",
  polish: "poland",
  czech: "czech republic",
  russian: "russia",
  ukrainian: "ukraine",
  brazilian: "brazil",
  argentine: "argentina",
  mexican: "mexico",
  american: "usa",
  japanese: "japan",
  korean: "korea",
  chinese: "china",
  australian: "australia",
};

// Re-export the basic normalizers so callers don't have to learn the
// new namespace. Identical behavior to the legacy implementation.
export const normalize = entityNormalize;
export const normalizeCompetition = entityNormalizeCompetition;

// ──────────────────────────────────────────────────────────────────────
// Per-process resolved-name cache, populated by `preResolveAll()` before
// matchEvents starts its O(n²) scoring. Keeps the hot path purely sync.
// ──────────────────────────────────────────────────────────────────────

// Per-event resolved-name cache populated by `preResolveAll()` before the
// matcher's O(n²) scoring loop. The cache holds the canonical normalized
// surface for home + away + competition so per-comparison lookups stay
// purely sync and the same canonical is used by both sides of the
// similarity score.
interface ResolvedNames {
  home: string;
  away: string;
  competition: string;
}

const resolvedCache = new Map<string, ResolvedNames>();

function eventKey(event: NormalizedEvent): string {
  return event.id;
}

/**
 * Apply team alias synchronously. Falls back to the basic normalize —
 * the entity resolver is consulted only via `preResolveAll()` because
 * the resolver is async (Postgres-backed) and the matcher's per-pair
 * scoring loop must stay sync.
 */
export function applyTeamAlias(name: string): string {
  return normalize(name);
}

export function applyCompetitionAlias(name: string): string {
  return normalizeCompetition(name);
}

// ──────────────────────────────────────────────────────────────────────
// Pre-Normalization (computed once per event)
// ──────────────────────────────────────────────────────────────────────

export interface PreNormalizedNames {
  home: string;
  away: string;
  competition: string;
}

/**
 * Build the pre-normalized name set for a single event. Sync — uses the
 * already-resolved cache populated by `preResolveAll()` if available,
 * else falls back to plain `normalize`.
 */
export function preNormalizeEvent(event: NormalizedEvent): PreNormalizedNames {
  const cached = resolvedCache.get(eventKey(event));
  if (cached) return cached;
  return {
    home: normalize(event.homeTeam),
    away: normalize(event.awayTeam),
    competition: normalizeCompetition(event.competition),
  };
}

/**
 * Pre-normalize all events, returning the per-event lookup map. Cheap
 * synchronous helper that operates on the local cache.
 */
export function preNormalizeAll(
  events: NormalizedEvent[],
): Map<string, PreNormalizedNames> {
  const map = new Map<string, PreNormalizedNames>();
  for (const event of events) {
    map.set(event.id, preNormalizeEvent(event));
  }
  return map;
}

/**
 * Async pre-resolve pass. Looks up every (provider, surface, competition)
 * tuple via the entity resolver, fills the per-event cache, then
 * `preNormalizeAll()` returns the resolved canonical names sync. The
 * matcher calls this before kicking off its scoring loop.
 *
 * Best-effort — failures are swallowed so a cold/unavailable resolver
 * just degrades to plain normalize.
 */
export async function preResolveAll(events: NormalizedEvent[]): Promise<void> {
  // Step 1 — resolve every distinct competition surface so we can pass
  // the competition_id when resolving teams.
  const compResolutions = new Map<string, string | null>();
  for (const event of events) {
    if (compResolutions.has(event.competition)) continue;
    const provider =
      (Object.keys(event.providers)[0] as string | undefined) ?? "unknown";
    try {
      const r = await resolveCompetitionSurface({
        provider,
        surface: event.competition,
      });
      compResolutions.set(event.competition, r?.entity.id ?? null);
    } catch {
      compResolutions.set(event.competition, null);
    }
  }

  // Step 2 — resolve teams using the now-known competition_id.
  for (const event of events) {
    const provider =
      (Object.keys(event.providers)[0] as string | undefined) ?? "unknown";
    const competitionId = compResolutions.get(event.competition) ?? null;
    let resolvedHome = normalize(event.homeTeam);
    let resolvedAway = normalize(event.awayTeam);
    let resolvedComp = normalizeCompetition(event.competition);
    try {
      const home = await resolveTeamSurface({
        provider,
        surface: event.homeTeam,
        competitionId,
      });
      if (home) resolvedHome = normalize(home.entity.canonicalName);
    } catch {
      // ignore
    }
    try {
      const away = await resolveTeamSurface({
        provider,
        surface: event.awayTeam,
        competitionId,
      });
      if (away) resolvedAway = normalize(away.entity.canonicalName);
    } catch {
      // ignore
    }
    if (competitionId) {
      try {
        // Comp surface already resolved; use the canonical entity name as
        // the resolved comp string so siblings collapse.
        const compRow = await resolveCompetitionSurface({
          provider,
          surface: event.competition,
        });
        if (compRow)
          resolvedComp = normalizeCompetition(compRow.entity.canonicalName);
      } catch {
        // ignore
      }
    }
    resolvedCache.set(eventKey(event), {
      home: resolvedHome,
      away: resolvedAway,
      competition: resolvedComp,
    });
  }
}

/**
 * Drop any cache entries for events not in the given set. Lets the
 * matcher prune the cache on each sync cycle so the resolver cache
 * doesn't grow unbounded.
 */
export function pruneResolvedCache(currentIds: Set<string>): void {
  for (const id of resolvedCache.keys()) {
    if (!currentIds.has(id)) resolvedCache.delete(id);
  }
}
