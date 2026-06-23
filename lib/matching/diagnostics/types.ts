
import { z } from "zod";
import type { ProviderKey } from "../../providers/registry";


export interface MatchScoreBreakdown {
  teamScore: number;
  homeHomeSimilarity: number;
  awayAwaySimilarity: number;
  homeAwaySimilarity: number;
  awayHomeSimilarity: number;
  bestOrientation: "normal" | "swapped";

  competitionScore: number;
  competitionA: string;
  competitionB: string;

  timeScore: number;
  timeDiffMs: number;

  finalScore: number;
}


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


export interface NearMatchEvent {
  id: string;
  provider: ProviderKey;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startTime: Date;
}

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


export type FailurePatternType =
  | "team_alias"
  | "competition_alias"
  | "time_offset";

export interface FailurePattern {
  patternType: FailurePatternType;
  occurrences: number;
  examples: NearMatch[];
  suggestedFix: string;
  key: string;
}


export interface DiagnosticStats {
  totalNearMatches: number;
  pending: number;
  confirmed: number;
  rejected: number;
  avgScore: number;
  lastAnalysis: Date | null;
  patterns: FailurePattern[];
}


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


export const NEAR_MATCH_MIN_SCORE = 0.75;
export const NEAR_MATCH_MAX_SCORE = 0.849;
export const NEAR_MATCH_MIN_TEAM_SCORE = 0.55;
export const NEAR_MATCH_MIN_BEST_SINGLE_TEAM = 0.4;
export const MAX_NEAR_MATCHES = 500;
export const NEAR_MATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
