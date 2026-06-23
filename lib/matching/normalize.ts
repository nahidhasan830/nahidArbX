
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

export const normalize = entityNormalize;
export const normalizeCompetition = entityNormalizeCompetition;


interface ResolvedNames {
  home: string;
  away: string;
  competition: string;
}

const resolvedCache = new Map<string, ResolvedNames>();

function eventKey(event: NormalizedEvent): string {
  return event.id;
}

export function applyTeamAlias(name: string): string {
  return normalize(name);
}

export function applyCompetitionAlias(name: string): string {
  return normalizeCompetition(name);
}


export interface PreNormalizedNames {
  home: string;
  away: string;
  competition: string;
}

export function preNormalizeEvent(event: NormalizedEvent): PreNormalizedNames {
  const cached = resolvedCache.get(eventKey(event));
  if (cached) return cached;
  return {
    home: normalize(event.homeTeam),
    away: normalize(event.awayTeam),
    competition: normalizeCompetition(event.competition),
  };
}

export function preNormalizeAll(
  events: NormalizedEvent[],
): Map<string, PreNormalizedNames> {
  const map = new Map<string, PreNormalizedNames>();
  for (const event of events) {
    map.set(event.id, preNormalizeEvent(event));
  }
  return map;
}

export async function preResolveAll(events: NormalizedEvent[]): Promise<void> {
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
    }
    try {
      const away = await resolveTeamSurface({
        provider,
        surface: event.awayTeam,
        competitionId,
      });
      if (away) resolvedAway = normalize(away.entity.canonicalName);
    } catch {
    }
    if (competitionId) {
      try {
        const compRow = await resolveCompetitionSurface({
          provider,
          surface: event.competition,
        });
        if (compRow)
          resolvedComp = normalizeCompetition(compRow.entity.canonicalName);
      } catch {
      }
    }
    resolvedCache.set(eventKey(event), {
      home: resolvedHome,
      away: resolvedAway,
      competition: resolvedComp,
    });
  }
}

export function pruneResolvedCache(currentIds: Set<string>): void {
  for (const id of resolvedCache.keys()) {
    if (!currentIds.has(id)) resolvedCache.delete(id);
  }
}
