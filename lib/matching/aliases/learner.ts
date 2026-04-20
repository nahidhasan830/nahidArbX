/**
 * Alias Auto-Learner
 *
 * Extracts aliases from confirmed near-matches and saves them.
 * Uses Pinnacle as the canonical source when available.
 */

import type { NearMatch } from "../diagnostics/types";
import { updateNearMatchStatus, getNearMatchById } from "../diagnostics/store";
import { addTeamAlias, addCompetitionAlias } from "./store";
import { logger } from "../../shared/logger";

// ============================================
// Types
// ============================================

export interface LearnedAliases {
  teamAliases: { source: string; canonical: string }[];
  competitionAliases: { source: string; canonical: string }[];
}

// ============================================
// Learning Logic
// ============================================

/**
 * Learn aliases from a confirmed near-match.
 *
 * When a user confirms that two events are the same, we extract
 * differing names as aliases. Uses Pinnacle as canonical source
 * when available (most reliable team names with explicit HOME/AWAY).
 */
export function learnFromConfirmedMatch(
  nearMatch: NearMatch,
  userId?: string,
): LearnedAliases {
  const learned: LearnedAliases = {
    teamAliases: [],
    competitionAliases: [],
  };

  // Update status first
  updateNearMatchStatus(nearMatch.id, "confirmed", userId);

  // Determine canonical source - prefer Pinnacle
  const pinnacleEvent =
    nearMatch.eventA.provider === "pinnacle"
      ? nearMatch.eventA
      : nearMatch.eventB.provider === "pinnacle"
        ? nearMatch.eventB
        : null;

  const otherEvent =
    pinnacleEvent === nearMatch.eventA ? nearMatch.eventB : nearMatch.eventA;

  // If no Pinnacle, use the event with longer team names (usually more complete)
  const canonicalEvent =
    pinnacleEvent ||
    (nearMatch.eventA.homeTeam.length >= nearMatch.eventB.homeTeam.length
      ? nearMatch.eventA
      : nearMatch.eventB);
  const variantEvent =
    canonicalEvent === nearMatch.eventA ? nearMatch.eventB : nearMatch.eventA;

  const orientation = nearMatch.breakdown.bestOrientation;

  // Learn team aliases
  const { homeAlias, awayAlias } = extractTeamAliases(
    canonicalEvent,
    variantEvent,
    orientation,
    nearMatch.breakdown,
    userId,
  );

  if (homeAlias) {
    learned.teamAliases.push(homeAlias);
  }
  if (awayAlias) {
    learned.teamAliases.push(awayAlias);
  }

  // Learn competition alias
  const compAlias = extractCompetitionAlias(
    canonicalEvent,
    variantEvent,
    nearMatch.breakdown,
    userId,
  );

  if (compAlias) {
    learned.competitionAliases.push(compAlias);
  }

  logger.info(
    "Learner",
    `Learned ${learned.teamAliases.length} team aliases, ` +
      `${learned.competitionAliases.length} competition aliases from confirmed match`,
  );

  return learned;
}

/**
 * Extract team aliases from a confirmed match.
 */
function extractTeamAliases(
  canonicalEvent: NearMatch["eventA"],
  variantEvent: NearMatch["eventB"],
  orientation: "normal" | "swapped",
  breakdown: NearMatch["breakdown"],
  userId?: string,
): {
  homeAlias: { source: string; canonical: string } | null;
  awayAlias: { source: string; canonical: string } | null;
} {
  let homeAlias: { source: string; canonical: string } | null = null;
  let awayAlias: { source: string; canonical: string } | null = null;

  const canonicalHome = canonicalEvent.homeTeam.toLowerCase().trim();
  const canonicalAway = canonicalEvent.awayTeam.toLowerCase().trim();

  // Get variant team based on orientation
  const variantHome =
    orientation === "normal"
      ? variantEvent.homeTeam.toLowerCase().trim()
      : variantEvent.awayTeam.toLowerCase().trim();

  const variantAway =
    orientation === "normal"
      ? variantEvent.awayTeam.toLowerCase().trim()
      : variantEvent.homeTeam.toLowerCase().trim();

  // Learn home team alias if different
  // Note: We learn aliases even for high-similarity pairs (like "Weg Taif" vs "Weg Taif SC")
  // because those trivial variations are exactly what aliases help resolve
  if (canonicalHome !== variantHome) {
    addTeamAlias(variantHome, canonicalHome, {
      autoLearned: true,
      addedBy: userId,
    });
    homeAlias = { source: variantHome, canonical: canonicalHome };
  }

  // Learn away team alias if different
  if (canonicalAway !== variantAway) {
    addTeamAlias(variantAway, canonicalAway, {
      autoLearned: true,
      addedBy: userId,
    });
    awayAlias = { source: variantAway, canonical: canonicalAway };
  }

  return { homeAlias, awayAlias };
}

/**
 * Extract competition alias from a confirmed match.
 */
function extractCompetitionAlias(
  canonicalEvent: NearMatch["eventA"],
  variantEvent: NearMatch["eventB"],
  breakdown: NearMatch["breakdown"],
  userId?: string,
): { source: string; canonical: string } | null {
  const compA = canonicalEvent.competition.toLowerCase().trim();
  const compB = variantEvent.competition.toLowerCase().trim();

  // Learn if different (even high-similarity variations are useful aliases)
  if (compA !== compB) {
    // Use longer name as canonical (usually more specific)
    const [canonical, variant] =
      compA.length >= compB.length ? [compA, compB] : [compB, compA];

    addCompetitionAlias(variant, canonical, {
      autoLearned: true,
      addedBy: userId,
    });

    return { source: variant, canonical };
  }

  return null;
}

// ============================================
// Match Operations
// ============================================

/**
 * Confirm a near-match by ID and learn aliases.
 */
export function confirmNearMatch(
  nearMatchId: string,
  userId?: string,
): LearnedAliases | null {
  const nearMatch = getNearMatchById(nearMatchId);
  if (!nearMatch) {
    logger.warn("Learner", `Near-match not found: ${nearMatchId}`);
    return null;
  }

  if (nearMatch.status !== "pending") {
    logger.warn(
      "Learner",
      `Near-match ${nearMatchId} already ${nearMatch.status}`,
    );
    return null;
  }

  return learnFromConfirmedMatch(nearMatch, userId);
}

/**
 * Reject a near-match (mark as not-same-event).
 */
export function rejectNearMatch(nearMatchId: string, userId?: string): boolean {
  const result = updateNearMatchStatus(nearMatchId, "rejected", userId);
  return result !== null;
}

// ============================================
// Bulk Operations
// ============================================

/**
 * Auto-confirm high-confidence near-matches.
 * Use with caution - only for scores very close to threshold.
 */
export function autoConfirmHighConfidence(
  minScore: number = 0.83,
  userId: string = "auto",
): LearnedAliases[] {
  // Import here to avoid circular dependency
  const { getNearMatches } = require("../diagnostics/store");

  const candidates = getNearMatches({
    status: "pending",
    minScore,
  });

  const results: LearnedAliases[] = [];

  for (const nearMatch of candidates) {
    // Additional safety checks for auto-confirmation
    const { breakdown } = nearMatch;

    // Only auto-confirm if team score is very high
    if (breakdown.teamScore >= 0.9) {
      const learned = learnFromConfirmedMatch(nearMatch, userId);
      results.push(learned);
    }
  }

  logger.info(
    "Learner",
    `Auto-confirmed ${results.length} high-confidence near-matches`,
  );

  return results;
}
