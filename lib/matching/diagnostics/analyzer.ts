/**
 * Match Score Analyzer
 *
 * Computes detailed score breakdowns and detects near-matches.
 * Enhanced version of the scoring logic with full diagnostics.
 */

import { cachedCompareTwoStrings as compareTwoStrings } from "../similarity-cache";
import type { NormalizedEvent } from "../../types";
import type { ProviderKey } from "../../providers/registry";
import type { MatchScoreBreakdown, NearMatch, FailureReason } from "./types";
import {
  NEAR_MATCH_MIN_SCORE,
  NEAR_MATCH_MAX_SCORE,
  NEAR_MATCH_MIN_TEAM_SCORE,
  NEAR_MATCH_MIN_BEST_SINGLE_TEAM,
} from "./types";
import { MATCH_THRESHOLD } from "../../shared/constants";
import {
  applyTeamAlias,
  applyCompetitionAlias,
  type PreNormalizedNames,
} from "../normalize";
import { computePairKey } from "../pair-key";
import {
  upsertMatchPair,
  getByPairKey,
} from "../../db/repositories/match-pairs";
import { logger as log } from "../../shared/logger";

// ============================================
// Score Computation
// ============================================

/**
 * Compute detailed score breakdown between two events.
 * Returns full breakdown instead of just final score.
 */
export function computeDetailedScore(
  a: NormalizedEvent,
  b: NormalizedEvent,
  preNormA?: PreNormalizedNames,
  preNormB?: PreNormalizedNames,
): MatchScoreBreakdown {
  // Use pre-normalized names if available, otherwise normalize on the fly
  const homeA = preNormA?.home ?? applyTeamAlias(a.homeTeam);
  const homeB = preNormB?.home ?? applyTeamAlias(b.homeTeam);
  const awayA = preNormA?.away ?? applyTeamAlias(a.awayTeam);
  const awayB = preNormB?.away ?? applyTeamAlias(b.awayTeam);

  // Normal orientation
  const homeHomeSimilarity = compareTwoStrings(homeA, homeB);
  const awayAwaySimilarity = compareTwoStrings(awayA, awayB);
  const normalTeamScore = (homeHomeSimilarity + awayAwaySimilarity) / 2;

  // Swapped orientation
  const homeAwaySimilarity = compareTwoStrings(homeA, awayB);
  const awayHomeSimilarity = compareTwoStrings(awayA, homeB);
  const swappedTeamScore = (homeAwaySimilarity + awayHomeSimilarity) / 2;

  const bestOrientation: "normal" | "swapped" =
    normalTeamScore >= swappedTeamScore ? "normal" : "swapped";
  const teamScore = Math.max(normalTeamScore, swappedTeamScore);

  // Competition score (with pre-normalized values or on-the-fly)
  const competitionA =
    preNormA?.competition ?? applyCompetitionAlias(a.competition);
  const competitionB =
    preNormB?.competition ?? applyCompetitionAlias(b.competition);
  const competitionScore = compareTwoStrings(competitionA, competitionB);

  // Time score (kept for diagnostics/deep matcher, but NOT used in Tier 1 formula)
  const timeDiffMs = Math.abs(a.startTime.getTime() - b.startTime.getTime());
  const timeScore = Math.max(0, 1 - timeDiffMs / (2 * 60 * 60 * 1000)); // 2-hour window

  // Final weighted score — time is implicit in grouping (exact-time buckets)
  // so we distribute weight between team (70%) and competition (30%) only
  const finalScore = 0.7 * teamScore + 0.3 * competitionScore;

  return {
    teamScore,
    homeHomeSimilarity,
    awayAwaySimilarity,
    homeAwaySimilarity,
    awayHomeSimilarity,
    bestOrientation,
    competitionScore,
    competitionA,
    competitionB,
    timeScore,
    timeDiffMs,
    finalScore,
  };
}

// ============================================
// Failure Analysis
// ============================================

/**
 * Analyze why a match failed based on score breakdown.
 */
export function analyzeFailureReasons(
  breakdown: MatchScoreBreakdown,
  eventA: NormalizedEvent,
  eventB: NormalizedEvent,
): FailureReason[] {
  const reasons: FailureReason[] = [];

  // Team mismatch (weighted 60%)
  if (breakdown.teamScore < 0.8) {
    const homeScore =
      breakdown.bestOrientation === "normal"
        ? breakdown.homeHomeSimilarity
        : breakdown.homeAwaySimilarity;
    const awayScore =
      breakdown.bestOrientation === "normal"
        ? breakdown.awayAwaySimilarity
        : breakdown.awayHomeSimilarity;

    reasons.push({
      type: "team_mismatch",
      details: {
        homeScore,
        awayScore,
        teamA: { home: eventA.homeTeam, away: eventA.awayTeam },
        teamB: { home: eventB.homeTeam, away: eventB.awayTeam },
      },
    });
  }

  // Competition mismatch (weighted 20%)
  if (breakdown.competitionScore < 0.8) {
    reasons.push({
      type: "competition_mismatch",
      details: {
        score: breakdown.competitionScore,
        competitionA: eventA.competition,
        competitionB: eventB.competition,
      },
    });
  }

  // Time mismatch (weighted 20%)
  if (breakdown.timeDiffMs > 5 * 60 * 1000) {
    // > 5 minutes
    reasons.push({
      type: "time_mismatch",
      details: {
        diffMs: breakdown.timeDiffMs,
        diffMinutes: Math.round(breakdown.timeDiffMs / 60000),
      },
    });
  }

  // Overall threshold failure
  if (breakdown.finalScore < MATCH_THRESHOLD) {
    reasons.push({
      type: "score_below_threshold",
      details: {
        score: breakdown.finalScore,
        threshold: MATCH_THRESHOLD,
        gap: MATCH_THRESHOLD - breakdown.finalScore,
      },
    });
  }

  return reasons;
}

// ============================================
// Near-Match Detection
// ============================================

/**
 * Check if a pair qualifies as a near-match and persist it to Postgres.
 * Called when events don't meet the match threshold.
 */
export async function detectAndStoreNearMatch(
  eventA: NormalizedEvent,
  eventB: NormalizedEvent,
  breakdown: MatchScoreBreakdown,
): Promise<NearMatch | null> {
  // Only track if in near-match range
  if (
    breakdown.finalScore < NEAR_MATCH_MIN_SCORE ||
    breakdown.finalScore > NEAR_MATCH_MAX_SCORE
  ) {
    return null;
  }

  // Team-score floor: reject pairs where the combined score is boosted
  // mainly by competition similarity (same league, same kickoff minute).
  // Team names are the only reliable signal when start times overlap.
  if (breakdown.teamScore < NEAR_MATCH_MIN_TEAM_SCORE) {
    return null;
  }

  // Best single-team gate: at least one team pair in the best orientation
  // must have meaningful similarity — catches "FC X" vs "FC Y" noise.
  const bestSingleTeam =
    breakdown.bestOrientation === "normal"
      ? Math.max(breakdown.homeHomeSimilarity, breakdown.awayAwaySimilarity)
      : Math.max(breakdown.homeAwaySimilarity, breakdown.awayHomeSimilarity);
  if (bestSingleTeam < NEAR_MATCH_MIN_BEST_SINGLE_TEAM) {
    return null;
  }

  const providerA = Object.keys(eventA.providers)[0] as ProviderKey;
  const providerB = Object.keys(eventB.providers)[0] as ProviderKey;

  // Skip if same provider
  if (providerA === providerB) {
    return null;
  }

  const pairKey = computePairKey(eventA, eventB, {
    team: applyTeamAlias,
    competition: applyCompetitionAlias,
  });

  // Skip if this pair already exists in the ML pipeline with a decision
  const existing = await getByPairKey(pairKey);
  if (existing?.decision) {
    return null;
  }

  const nearMatch: NearMatch = {
    id: `nm-${eventA.id}-${eventB.id}`,
    eventA: {
      id: eventA.id,
      provider: providerA,
      homeTeam: eventA.homeTeam,
      awayTeam: eventA.awayTeam,
      competition: eventA.competition,
      startTime: eventA.startTime,
    },
    eventB: {
      id: eventB.id,
      provider: providerB,
      homeTeam: eventB.homeTeam,
      awayTeam: eventB.awayTeam,
      competition: eventB.competition,
      startTime: eventB.startTime,
    },
    breakdown,
    failureReasons: analyzeFailureReasons(breakdown, eventA, eventB),
    detectedAt: new Date(),
    status: "pending",
  };

  try {
    await upsertMatchPair({
      pairKey,
      source: "near-match",
      stringScore: breakdown.finalScore,
      stringBreakdown: breakdown,
      eventA: {
        provider: providerA,
        homeTeam: eventA.homeTeam,
        awayTeam: eventA.awayTeam,
        competition: eventA.competition,
        startTime: eventA.startTime,
        eventId: eventA.providers[providerA]?.eventId,
      },
      eventB: {
        provider: providerB,
        homeTeam: eventB.homeTeam,
        awayTeam: eventB.awayTeam,
        competition: eventB.competition,
        startTime: eventB.startTime,
        eventId: eventB.providers[providerB]?.eventId,
      },
    });
  } catch (err) {
    log.warn(
      "Diagnostics",
      `upsertMatchPair failed: ${(err as Error).message}`,
    );
  }

  return nearMatch;
}

/**
 * Check if score qualifies as a near-match (for external callers).
 */
export function isNearMatch(score: number): boolean {
  return score >= NEAR_MATCH_MIN_SCORE && score < MATCH_THRESHOLD;
}

/**
 * Check if score qualifies as a full match.
 */
export function isFullMatch(score: number): boolean {
  return score >= MATCH_THRESHOLD;
}
