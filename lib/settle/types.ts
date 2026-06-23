import type { Outcome } from "../bets-history/types";

export type MatchStatus = "FT" | "AET" | "PEN" | "ABD" | "POSTPONED";

export type ScoreSource =
  | "pinnacle-ws"
  | "betconstruct"
  | "football-data"
  | "espn"
  | "api-football"
  | "sofascore"
  | "openligadb"
  | "pinnacle-settled"
  | "manual";

export interface MatchScore {
  eventId: string;
  status: MatchStatus;
  htHome: number | null;
  htAway: number | null;
  ftHome: number;
  ftAway: number;
  etHome?: number | null;
  etAway?: number | null;
  penHome?: number | null;
  penAway?: number | null;
  cornersHome?: number | null;
  cornersAway?: number | null;
  htCornersHome?: number | null;
  htCornersAway?: number | null;
  bookingsHome?: number | null;
  bookingsAway?: number | null;
  source: ScoreSource;
  confidence: number;
  sourceUrl?: string | null;
  fetchedAt?: string;
}

export type SettleReason =
  | "resolved"
  | "abandoned"
  | "postponed"
  | "unsupported-market"
  | "missing-ht-score"
  | "unknown-atom";

export interface SettleResult {
  outcome: Outcome;
  scopeScore: string;
  confidence: number;
  reasoning: string;
  reason: SettleReason;
}
