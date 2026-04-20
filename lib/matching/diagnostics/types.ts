/**
 * Match Diagnostics Types
 *
 * Types for near-match detection, score breakdowns, and failure analysis.
 */

import { z } from "zod";
import type { ProviderKey } from "../../providers/registry";

// ============================================
// Score Breakdown
// ============================================

/**
 * Detailed breakdown of match score computation.
 * Provides granular insight into why a match succeeded or failed.
 */
export interface MatchScoreBreakdown {
  // Team similarity (weighted 70%)
  teamScore: number;
  homeHomeSimilarity: number; // Home vs Home
  awayAwaySimilarity: number; // Away vs Away
  homeAwaySimilarity: number; // Swapped: Home vs Away
  awayHomeSimilarity: number; // Swapped: Away vs Home
  bestOrientation: "normal" | "swapped";

  // Competition similarity (weighted 30%)
  competitionScore: number;
  competitionA: string; // Normalized competition A
  competitionB: string; // Normalized competition B

  // Time proximity (kept for diagnostics, NOT in Tier 1 formula)
  timeScore: number;
  timeDiffMs: number;

  // Final weighted score: 0.7*team + 0.3*comp
  finalScore: number;
}

// ============================================
// Failure Reasons
// ============================================

export type FailureReason =
  | {
      type: "team_mismatch";
      details: {
        homeScore: number;
        awayScore: number;
        teamA: { home: string; away: string };
        teamB: { home: string; away: string };
      };
    }
  | {
      type: "competition_mismatch";
      details: {
        score: number;
        competitionA: string;
        competitionB: string;
      };
    }
  | {
      type: "time_mismatch";
      details: {
        diffMs: number;
        diffMinutes: number;
      };
    }
  | {
      type: "score_below_threshold";
      details: {
        score: number;
        threshold: number;
        gap: number;
      };
    };

// ============================================
// Near-Match
// ============================================

export interface NearMatchEvent {
  id: string;
  provider: ProviderKey;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startTime: Date;
}

/**
 * A potential match that scored between NEAR_MATCH_MIN and MATCH_THRESHOLD.
 * These are candidates for manual review and alias learning.
 */
export interface NearMatch {
  id: string;
  eventA: NearMatchEvent;
  eventB: NearMatchEvent;
  breakdown: MatchScoreBreakdown;
  failureReasons: FailureReason[];
  detectedAt: Date;
  status: "pending" | "confirmed" | "rejected";
  confirmedBy?: string;
  confirmedAt?: Date;
}

// ============================================
// Failure Patterns
// ============================================

export type FailurePatternType =
  | "team_alias"
  | "competition_alias"
  | "time_offset";

export interface FailurePattern {
  patternType: FailurePatternType;
  occurrences: number;
  examples: NearMatch[];
  suggestedFix: string;
  key: string; // Unique identifier for deduplication
}

// ============================================
// Diagnostic Stats
// ============================================

export interface DiagnosticStats {
  totalNearMatches: number;
  pending: number;
  confirmed: number;
  rejected: number;
  avgScore: number;
  lastAnalysis: Date | null;
  patterns: FailurePattern[];
}

// ============================================
// Zod Schemas for Validation
// ============================================

export const NearMatchEventSchema = z.object({
  id: z.string(),
  provider: z.string(),
  homeTeam: z.string(),
  awayTeam: z.string(),
  competition: z.string(),
  startTime: z.coerce.date(),
});

export const MatchScoreBreakdownSchema = z.object({
  teamScore: z.number(),
  homeHomeSimilarity: z.number(),
  awayAwaySimilarity: z.number(),
  homeAwaySimilarity: z.number(),
  awayHomeSimilarity: z.number(),
  bestOrientation: z.enum(["normal", "swapped"]),
  competitionScore: z.number(),
  competitionA: z.string(),
  competitionB: z.string(),
  timeScore: z.number(),
  timeDiffMs: z.number(),
  finalScore: z.number(),
});

export const FailureReasonSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("team_mismatch"),
    details: z.object({
      homeScore: z.number(),
      awayScore: z.number(),
      teamA: z.object({ home: z.string(), away: z.string() }),
      teamB: z.object({ home: z.string(), away: z.string() }),
    }),
  }),
  z.object({
    type: z.literal("competition_mismatch"),
    details: z.object({
      score: z.number(),
      competitionA: z.string(),
      competitionB: z.string(),
    }),
  }),
  z.object({
    type: z.literal("time_mismatch"),
    details: z.object({
      diffMs: z.number(),
      diffMinutes: z.number(),
    }),
  }),
  z.object({
    type: z.literal("score_below_threshold"),
    details: z.object({
      score: z.number(),
      threshold: z.number(),
      gap: z.number(),
    }),
  }),
]);

export const NearMatchSchema = z.object({
  id: z.string(),
  eventA: NearMatchEventSchema,
  eventB: NearMatchEventSchema,
  breakdown: MatchScoreBreakdownSchema,
  failureReasons: z.array(FailureReasonSchema),
  detectedAt: z.coerce.date(),
  status: z.enum(["pending", "confirmed", "rejected"]),
  confirmedBy: z.string().optional(),
  confirmedAt: z.coerce.date().optional(),
});

// ============================================
// Constants
// ============================================

export const NEAR_MATCH_MIN_SCORE = 0.7;
export const NEAR_MATCH_MAX_SCORE = 0.849; // Just below threshold
export const MAX_NEAR_MATCHES = 500;
export const NEAR_MATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
