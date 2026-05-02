/**
 * Multi-Source Score Store
 *
 * Unified store for scores from multiple providers (Pinnacle, BetConstruct).
 * Keyed by NORMALIZED event ID (not provider-specific).
 *
 * Features:
 * - Fallback logic: Pinnacle primary, BC fallback
 * - Cross-checking: Detects discrepancies between sources
 * - Confidence levels: high/medium/low/stale
 */

import type {
  ScoreSource,
  ScoreConfidence,
  SourceScore,
  MultiSourceScore,
  MultiSourceDisplayScore,
} from "./types";
import { saveScoreIfAbsent } from "../db/repositories/match-scores";
import { logger } from "../shared/logger";

// ============================================
// Stores
// ============================================

/** Main store keyed by normalized event ID */
const multiScoreStore = new Map<string, MultiSourceScore>();

/** Index: "provider:eventId" -> normalizedId */
const providerIdIndex = new Map<string, string>();

// Stale threshold: 30 seconds
const STALE_THRESHOLD_MS = 30_000;

/**
 * eventIds for which we've already flushed a terminal-state score to the
 * match_scores cache. Prevents re-writing the same FT score on every
 * 10s poll tick once a match finishes. Survives process lifetime; cleared
 * on restart (at which point DB already has the row anyway).
 */
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

  // Pull HT from whichever source has it — Pinnacle now captures it on
  // the 1H→2H transition. Fall back to `null` if neither source saw
  // the first half (e.g. we started subscribing in 2H).
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

  // Fire-and-forget; a failed write shouldn't break the live-score pipeline.
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

// ============================================
// Provider ID Mapping
// ============================================

/**
 * Register mapping from provider event ID to normalized event ID
 */
export function registerProviderEventId(
  provider: ScoreSource,
  providerEventId: string,
  normalizedEventId: string,
): void {
  const key = `${provider}:${providerEventId}`;
  providerIdIndex.set(key, normalizedEventId);
}

/**
 * Get normalized event ID from provider event ID
 */
export function getNormalizedId(
  provider: ScoreSource,
  providerEventId: string,
): string | null {
  const key = `${provider}:${providerEventId}`;
  return providerIdIndex.get(key) || null;
}

/**
 * Get provider event ID from normalized event ID
 */
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

/**
 * Register all provider mappings for a matched event
 */
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

// ============================================
// Score Storage
// ============================================

/**
 * Update a score from a specific source
 */
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

  // For Pinnacle, only update if version is newer
  const existing = entry.sources[score.source];
  if (
    score.source === "pinnacle" &&
    existing &&
    score.version &&
    existing.version &&
    score.version <= existing.version
  ) {
    return; // Skip stale update
  }

  // Carry HT forward if the new payload doesn't include it but a prior
  // one did. Live sources only see HT on the 1H→2H transition; after
  // that we rely on the previously-captured snapshot.
  const merged: SourceScore = {
    ...score,
    htHome: score.htHome ?? existing?.htHome,
    htAway: score.htAway ?? existing?.htAway,
  };

  // Update the source score
  entry.sources[score.source] = merged;
  entry.lastUpdated = Date.now();

  // Recalculate primary, confidence, and discrepancy
  recalculateEntry(entry);
}

/**
 * Get multi-source score by normalized event ID
 */
export function getMultiSourceScore(
  normalizedEventId: string,
): MultiSourceScore | null {
  const entry = multiScoreStore.get(normalizedEventId);
  if (!entry) return null;

  // Update staleness
  recalculateEntry(entry);
  return entry;
}

/**
 * Get score for display with multi-source info
 */
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

/**
 * Get score by provider event ID (for backward compatibility)
 */
export function getScoreByProviderEventId(
  provider: ScoreSource,
  providerEventId: string,
): SourceScore | null {
  const normalizedId = getNormalizedId(provider, providerEventId);
  if (!normalizedId) return null;

  const entry = multiScoreStore.get(normalizedId);
  return entry?.sources[provider] || null;
}

// ============================================
// Calculation Helpers
// ============================================

/**
 * Recalculate primary, confidence, and discrepancy for an entry
 *
 * Priority rules:
 * 1. If scores agree → use most recent
 * 2. If scores disagree → PREFER BC (more reliable polling vs WebSocket)
 * 3. If one is stale → use the fresh one
 */
function recalculateEntry(entry: MultiSourceScore): void {
  const pinnacle = entry.sources.pinnacle;
  const betconstruct = entry.sources.betconstruct;
  const now = Date.now();

  // Check for discrepancy FIRST (compare goals only, not minutes)
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

  // Determine primary score
  // When there's a discrepancy, ALWAYS prefer BC (it's polled, more reliable)
  if (entry.hasDiscrepancy && betconstruct) {
    entry.primary = betconstruct;
  } else if (
    betconstruct &&
    now - betconstruct.updatedAt < STALE_THRESHOLD_MS
  ) {
    // BC is fresh, prefer it
    entry.primary = betconstruct;
  } else if (pinnacle && now - pinnacle.updatedAt < STALE_THRESHOLD_MS) {
    // Pinnacle is fresh
    entry.primary = pinnacle;
  } else if (betconstruct) {
    // Use stale BC over stale Pinnacle (BC more reliable)
    entry.primary = betconstruct;
  } else if (pinnacle) {
    entry.primary = pinnacle;
  } else {
    entry.primary = null;
  }

  // Calculate confidence
  entry.confidence = calculateConfidence(entry, now);

  // Once the match reaches a terminal state, flush the final score to the
  // permanent match_scores cache. Guarded by persistedTerminalIds so we
  // only write once per event.
  maybePersistTerminalScore(entry);
}

/**
 * Calculate confidence level
 */
function calculateConfidence(
  entry: MultiSourceScore,
  now: number,
): ScoreConfidence {
  const pinnacle = entry.sources.pinnacle;
  const betconstruct = entry.sources.betconstruct;

  // If we have both and they agree
  if (pinnacle && betconstruct && !entry.hasDiscrepancy) {
    return "high";
  }

  // If sources disagree
  if (entry.hasDiscrepancy) {
    return "low";
  }

  // Single source available
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

// ============================================
// Stats and Cleanup
// ============================================

/**
 * Get all events with score discrepancies
 */
export function getDiscrepancyEvents(): string[] {
  const events: string[] = [];
  for (const [eventId, entry] of multiScoreStore) {
    if (entry.hasDiscrepancy) {
      events.push(eventId);
    }
  }
  return events;
}

/**
 * Get confidence statistics
 */
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

/**
 * Get count of tracked scores
 */
export function getMultiScoreCount(): number {
  return multiScoreStore.size;
}

/**
 * Cleanup old scores
 */
export function cleanupOldMultiScores(
  maxAgeMs: number = 3 * 60 * 60 * 1000,
): number {
  const now = Date.now();
  let removed = 0;

  for (const [eventId, entry] of multiScoreStore) {
    if (now - entry.lastUpdated > maxAgeMs) {
      multiScoreStore.delete(eventId);
      persistedTerminalIds.delete(eventId); // Don't let this set grow forever
      removed++;
    }
  }

  // Also cleanup provider index
  for (const [key, normalizedId] of providerIdIndex) {
    if (!multiScoreStore.has(normalizedId)) {
      providerIdIndex.delete(key);
    }
  }

  return removed;
}

/**
 * Clear all scores
 */
export function clearAllMultiScores(): void {
  multiScoreStore.clear();
  providerIdIndex.clear();
}
