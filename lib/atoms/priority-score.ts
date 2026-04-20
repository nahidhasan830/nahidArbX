/**
 * Priority Score Calculator for Value Bets
 *
 * Calculates a composite priority score based on:
 * - EV% (capped to deprioritize suspicious high-EV bets)
 * - Kelly stake recommendation (risk-adjusted confidence)
 * - Odds freshness (recency for actionability)
 * - Suspicious flag penalty
 *
 * Formula:
 *   Priority = (EV_weight × norm_EV) + (Kelly_weight × norm_Kelly) + (Freshness_weight × freshness) - suspicious_penalty
 *
 * Default weights: EV=0.5, Kelly=0.3, Freshness=0.2
 */

import {
  PRIORITY_EV_CAP,
  PRIORITY_WEIGHT_EV,
  PRIORITY_WEIGHT_KELLY,
  PRIORITY_WEIGHT_FRESHNESS,
  PRIORITY_SUSPICIOUS_PENALTY,
  PRIORITY_MAX_KELLY_PCT,
  VALUE_TOTAL_STAKE,
  MAX_VALUE_ODDS_AGE_MS,
} from "../shared/constants";

// ============================================
// Types
// ============================================

export interface PriorityScoreInput {
  evPct: number | null;
  kellyStake: number | null;
  timestamp: number;
  isSuspicious: boolean;
}

export interface PriorityScoreResult {
  score: number; // 0-1 normalized score
  normalizedEv: number; // 0-1
  normalizedKelly: number; // 0-1
  freshnessScore: number; // 0-1
  penalty: number; // 0 or PRIORITY_SUSPICIOUS_PENALTY
  reasons: string[]; // Human-readable breakdown
}

export interface PriorityWeights {
  ev: number;
  kelly: number;
  freshness: number;
}

// ============================================
// Score Calculation
// ============================================

/**
 * Calculate priority score for a value bet with full breakdown.
 *
 * @param input - Value bet data (evPct, kellyStake, timestamp, isSuspicious)
 * @param weights - Optional custom weights (defaults to constants)
 * @param bankroll - Optional bankroll for Kelly normalization (default 1000)
 * @returns Priority score result with component breakdown
 */
export function calculatePriorityScore(
  input: PriorityScoreInput,
  weights: PriorityWeights = {
    ev: PRIORITY_WEIGHT_EV,
    kelly: PRIORITY_WEIGHT_KELLY,
    freshness: PRIORITY_WEIGHT_FRESHNESS,
  },
  bankroll: number = VALUE_TOTAL_STAKE,
): PriorityScoreResult {
  const now = Date.now();
  const reasons: string[] = [];

  // 1. Normalized EV (capped at PRIORITY_EV_CAP to deprioritize palpable errors)
  const evPct = input.evPct ?? 0;
  const clampedEv = Math.min(Math.max(evPct, 0), PRIORITY_EV_CAP);
  const normalizedEv = clampedEv / PRIORITY_EV_CAP;

  if (evPct > PRIORITY_EV_CAP) {
    reasons.push(`EV capped (${evPct.toFixed(1)}% > ${PRIORITY_EV_CAP}%)`);
  }

  // 2. Normalized Kelly (as fraction of max reasonable bet)
  const kellyStake = input.kellyStake ?? 0;
  const maxKellyStake = bankroll * (PRIORITY_MAX_KELLY_PCT / 100);
  const normalizedKelly = Math.min(kellyStake / maxKellyStake, 1);

  // 3. Freshness score (1.0 = just fetched, 0.0 = stale)
  const ageMs = now - input.timestamp;
  const freshnessScore = Math.max(0, 1 - ageMs / MAX_VALUE_ODDS_AGE_MS);

  if (freshnessScore < 0.5) {
    reasons.push(`Stale odds (${Math.round(ageMs / 1000)}s old)`);
  }

  // 4. Suspicious penalty
  const penalty = input.isSuspicious ? PRIORITY_SUSPICIOUS_PENALTY : 0;

  if (input.isSuspicious) {
    reasons.push("Flagged as suspicious");
  }

  // Calculate weighted score
  const rawScore =
    weights.ev * normalizedEv +
    weights.kelly * normalizedKelly +
    weights.freshness * freshnessScore -
    penalty;

  // Clamp to 0-1 range
  const score = Math.max(0, Math.min(1, rawScore));

  return {
    score,
    normalizedEv,
    normalizedKelly,
    freshnessScore,
    penalty,
    reasons,
  };
}

/**
 * Calculate priority score (simple version - returns number only).
 * Use this for sorting when you don't need the breakdown.
 *
 * @param input - Value bet data
 * @returns Priority score (0-1, higher = better)
 */
export function getPriorityScore(input: PriorityScoreInput): number {
  return calculatePriorityScore(input).score;
}

/**
 * Sort items by priority score (descending).
 * Higher priority = better bet quality = earlier in list.
 *
 * @param items - Array of items with priority score inputs
 * @returns New sorted array (original unchanged)
 */
export function sortByPriority<T extends PriorityScoreInput>(items: T[]): T[] {
  return [...items].sort((a, b) => getPriorityScore(b) - getPriorityScore(a));
}

/**
 * Filter out suspicious high-EV bets (potential palpable errors).
 *
 * @param items - Array of items with evPct
 * @param maxEvPct - Maximum EV% to include (default PRIORITY_EV_CAP)
 * @returns Filtered array
 */
export function filterHighEv<T extends { evPct: number | null }>(
  items: T[],
  maxEvPct: number = PRIORITY_EV_CAP,
): T[] {
  return items.filter((item) => (item.evPct ?? 0) <= maxEvPct);
}
