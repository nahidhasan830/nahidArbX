
import type {
  ScoreSource,
  ScoreConfidence,
  SourceScore,
  MultiSourceScore,
  MultiSourceDisplayScore,
} from "./types";
import { saveScoreIfAbsent } from "../db/repositories/match-scores";
import { logger } from "../shared/logger";


const multiScoreStore = new Map<string, MultiSourceScore>();

const providerIdIndex = new Map<string, string>();

const STALE_THRESHOLD_MS = 30_000;

const persistedTerminalIds = new Set<string>();

const TERMINAL_PERIODS = new Set([
  "FT",
  "AET",
  "PEN",
  "ENDED",
  "FINISHED",
  "FULL TIME",
  "FULL-TIME",
]);

const normalizePeriod = (period: string | undefined): string =>
  (period ?? "").toUpperCase().trim();

const isTerminal = (period: string | undefined): boolean =>
  TERMINAL_PERIODS.has(normalizePeriod(period));

const maybePersistTerminalScore = (entry: MultiSourceScore): void => {
  if (persistedTerminalIds.has(entry.eventId)) return;
  const primary = entry.primary;
  if (!primary) return;
  if (!isTerminal(primary.period)) return;
  persistedTerminalIds.add(entry.eventId);

  const agreed =
    entry.sources.pinnacle &&
    entry.sources.betconstruct &&
    !entry.hasDiscrepancy;
  const confidence = agreed ? 0.98 : 0.85;
  const period = normalizePeriod(primary.period);
  const status: "FT" | "AET" | "PEN" =
    period === "AET" ? "AET" : period === "PEN" ? "PEN" : "FT";

  const htFromSources =
    primary.htHome !== undefined && primary.htAway !== undefined
      ? { home: primary.htHome, away: primary.htAway }
      : entry.sources.pinnacle?.htHome !== undefined &&
          entry.sources.pinnacle?.htAway !== undefined
        ? {
            home: entry.sources.pinnacle.htHome,
            away: entry.sources.pinnacle.htAway,
          }
        : entry.sources.betconstruct?.htHome !== undefined &&
            entry.sources.betconstruct?.htAway !== undefined
          ? {
              home: entry.sources.betconstruct.htHome,
              away: entry.sources.betconstruct.htAway,
            }
          : null;

  saveScoreIfAbsent({
    eventId: entry.eventId,
    status,
    htHome: htFromSources?.home ?? null,
    htAway: htFromSources?.away ?? null,
    ftHome: primary.homeScore,
    ftAway: primary.awayScore,
    source: primary.source === "pinnacle" ? "pinnacle-ws" : "betconstruct",
    confidence,
  }).catch((err) => {
    persistedTerminalIds.delete(entry.eventId);
    logger.warn(
      "Scores",
      `Terminal-score persist for ${entry.eventId} failed: ${(err as Error).message}`,
    );
  });
};


export function registerProviderEventId(
  provider: ScoreSource,
  providerEventId: string,
  normalizedEventId: string,
): void {
  const key = `${provider}:${providerEventId}`;
  providerIdIndex.set(key, normalizedEventId);
}

export function getNormalizedId(
  provider: ScoreSource,
  providerEventId: string,
): string | null {
  const key = `${provider}:${providerEventId}`;
  return providerIdIndex.get(key) || null;
}

export function getProviderEventId(
  normalizedId: string,
  provider: ScoreSource,
): string | null {
  for (const [key, nId] of providerIdIndex) {
    if (nId === normalizedId && key.startsWith(`${provider}:`)) {
      return key.replace(`${provider}:`, "");
    }
  }
  return null;
}

export function registerEventMappings(
  normalizedEventId: string,
  providers: Partial<Record<ScoreSource, string>>,
): void {
  for (const [provider, eventId] of Object.entries(providers)) {
    if (eventId) {
      registerProviderEventId(
        provider as ScoreSource,
        eventId,
        normalizedEventId,
      );
    }
  }
}


export function setSourceScore(
  normalizedEventId: string,
  score: SourceScore,
): void {
  let entry = multiScoreStore.get(normalizedEventId);

  if (!entry) {
    entry = {
      primary: null,
      sources: {},
      confidence: "medium",
      hasDiscrepancy: false,
      eventId: normalizedEventId,
      lastUpdated: Date.now(),
    };
    multiScoreStore.set(normalizedEventId, entry);
  }

  const existing = entry.sources[score.source];
  if (
    score.source === "pinnacle" &&
    existing &&
    score.version &&
    existing.version &&
    score.version <= existing.version
  ) {
    return;
  }

  const merged: SourceScore = {
    ...score,
    htHome: score.htHome ?? existing?.htHome,
    htAway: score.htAway ?? existing?.htAway,
  };

  entry.sources[score.source] = merged;
  entry.lastUpdated = Date.now();

  recalculateEntry(entry);
}

export function getMultiSourceScore(
  normalizedEventId: string,
): MultiSourceScore | null {
  const entry = multiScoreStore.get(normalizedEventId);
  if (!entry) return null;

  recalculateEntry(entry);
  return entry;
}

export function getMultiSourceDisplayScore(
  normalizedEventId: string,
): MultiSourceDisplayScore | null {
  const entry = getMultiSourceScore(normalizedEventId);
  if (!entry || !entry.primary) return null;

  const primary = entry.primary;
  const alternate = Object.values(entry.sources).find(
    (s) => s && s.source !== primary.source,
  );

  return {
    home: primary.homeScore,
    away: primary.awayScore,
    minute: primary.minute,
    period: primary.period,
    homeRedCards: primary.homeRedCards || 0,
    awayRedCards: primary.awayRedCards || 0,
    primarySource: primary.source,
    confidence: entry.confidence,
    hasDiscrepancy: entry.hasDiscrepancy,
    alternativeScore: alternate
      ? {
          source: alternate.source,
          home: alternate.homeScore,
          away: alternate.awayScore,
        }
      : undefined,
  };
}

export function getScoreByProviderEventId(
  provider: ScoreSource,
  providerEventId: string,
): SourceScore | null {
  const normalizedId = getNormalizedId(provider, providerEventId);
  if (!normalizedId) return null;

  const entry = multiScoreStore.get(normalizedId);
  return entry?.sources[provider] || null;
}


function recalculateEntry(entry: MultiSourceScore): void {
  const pinnacle = entry.sources.pinnacle;
  const betconstruct = entry.sources.betconstruct;
  const now = Date.now();

  if (pinnacle && betconstruct) {
    const homeMatch = pinnacle.homeScore === betconstruct.homeScore;
    const awayMatch = pinnacle.awayScore === betconstruct.awayScore;

    if (homeMatch && awayMatch) {
      entry.hasDiscrepancy = false;
      entry.discrepancy = undefined;
    } else {
      entry.hasDiscrepancy = true;
      entry.discrepancy = {
        goalDifference:
          Math.abs(pinnacle.homeScore - betconstruct.homeScore) +
          Math.abs(pinnacle.awayScore - betconstruct.awayScore),
        sources: ["pinnacle", "betconstruct"],
        detectedAt: now,
      };
      logger.warn(
        "Scores",
        `Discrepancy for ${entry.eventId}: Pinnacle ${pinnacle.homeScore}-${pinnacle.awayScore} vs BC ${betconstruct.homeScore}-${betconstruct.awayScore} (using BC)`,
      );
    }
  } else {
    entry.hasDiscrepancy = false;
    entry.discrepancy = undefined;
  }

  if (entry.hasDiscrepancy && betconstruct) {
    entry.primary = betconstruct;
  } else if (
    betconstruct &&
    now - betconstruct.updatedAt < STALE_THRESHOLD_MS
  ) {
    entry.primary = betconstruct;
  } else if (pinnacle && now - pinnacle.updatedAt < STALE_THRESHOLD_MS) {
    entry.primary = pinnacle;
  } else if (betconstruct) {
    entry.primary = betconstruct;
  } else if (pinnacle) {
    entry.primary = pinnacle;
  } else {
    entry.primary = null;
  }

  entry.confidence = calculateConfidence(entry, now);

  maybePersistTerminalScore(entry);
}

function calculateConfidence(
  entry: MultiSourceScore,
  now: number,
): ScoreConfidence {
  const pinnacle = entry.sources.pinnacle;
  const betconstruct = entry.sources.betconstruct;

  if (pinnacle && betconstruct && !entry.hasDiscrepancy) {
    return "high";
  }

  if (entry.hasDiscrepancy) {
    return "low";
  }

  const onlySource = pinnacle || betconstruct;
  if (onlySource) {
    const age = now - onlySource.updatedAt;
    if (age > STALE_THRESHOLD_MS) {
      return "stale";
    }
    return "medium";
  }

  return "stale";
}


export function getDiscrepancyEvents(): string[] {
  const events: string[] = [];
  for (const [eventId, entry] of multiScoreStore) {
    if (entry.hasDiscrepancy) {
      events.push(eventId);
    }
  }
  return events;
}

export function getConfidenceStats(): Record<ScoreConfidence, number> {
  const stats: Record<ScoreConfidence, number> = {
    high: 0,
    medium: 0,
    low: 0,
    stale: 0,
  };

  for (const entry of multiScoreStore.values()) {
    stats[entry.confidence]++;
  }

  return stats;
}

export function getMultiScoreCount(): number {
  return multiScoreStore.size;
}

export function cleanupOldMultiScores(
  maxAgeMs: number = 3 * 60 * 60 * 1000,
): number {
  const now = Date.now();
  let removed = 0;

  for (const [eventId, entry] of multiScoreStore) {
    if (now - entry.lastUpdated > maxAgeMs) {
      multiScoreStore.delete(eventId);
      persistedTerminalIds.delete(eventId);
      removed++;
    }
  }

  for (const [key, normalizedId] of providerIdIndex) {
    if (!multiScoreStore.has(normalizedId)) {
      providerIdIndex.delete(key);
    }
  }

  return removed;
}

export function clearAllMultiScores(): void {
  multiScoreStore.clear();
  providerIdIndex.clear();
}
