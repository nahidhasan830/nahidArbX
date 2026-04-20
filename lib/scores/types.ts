/**
 * Live Score Types
 *
 * Types for real-time match scores from Pinnacle WebSocket
 */

export interface LiveScore {
  eventId: string; // Parent event ID
  homeScore: number;
  awayScore: number;
  /**
   * Half-time score snapshot. Captured when the period transitions
   * 1 → 2 (end of 1st half) — Pinnacle's WS doesn't surface an
   * explicit HT field, so we snapshot the last-seen state=1 score
   * as the transition happens. Stays set for the rest of the match.
   */
  htHome?: number;
  htAway?: number;
  elapsed: number; // Match minute
  state: number; // Period (1 = 1st half, 2 = 2nd half, etc)
  homeRedCards: number;
  awayRedCards: number;
  resultingUnit: string; // "Regular", "Corners", etc.
  version: number; // Update version for conflict resolution
  updatedAt: number; // Timestamp when we received this update
}

export interface LiveScoreMessage {
  resultingUnit: string;
  eventId: number;
  eventParentId: number;
  homeScore: number;
  awayScore: number;
  homeRedCards: number;
  awayRedCards: number;
  state: number;
  elapsed: number;
  version: number;
}

/**
 * Corners score (tracked separately from regular goals)
 */
export interface CornersScore {
  eventId: string;
  homeCorners: number;
  awayCorners: number;
  version: number;
  updatedAt: number;
}

// Simplified score for UI display
export interface DisplayScore {
  home: number;
  away: number;
  minute: number;
  period: string; // "1H", "2H", "HT", "FT", etc.
  homeRedCards: number;
  awayRedCards: number;
}

/**
 * Convert state number to period string
 */
export function stateToPeriod(state: number, elapsed: number): string {
  switch (state) {
    case 1:
      return elapsed <= 45 ? "1H" : "HT";
    case 2:
      return "2H";
    case 3:
      return "ET"; // Extra time
    case 4:
      return "PEN"; // Penalties
    case 0:
    default:
      return elapsed > 0 ? "LIVE" : "PRE";
  }
}

/**
 * Convert LiveScore to DisplayScore
 */
export function toDisplayScore(score: LiveScore): DisplayScore {
  return {
    home: score.homeScore,
    away: score.awayScore,
    minute: score.elapsed,
    period: stateToPeriod(score.state, score.elapsed),
    homeRedCards: score.homeRedCards,
    awayRedCards: score.awayRedCards,
  };
}

// ============================================
// Multi-Source Score Types
// ============================================

/** Score source identifier */
export type ScoreSource = "pinnacle" | "betconstruct";

/** Confidence level for score data */
export type ScoreConfidence = "high" | "medium" | "low" | "stale";

/**
 * Score entry from a single source
 */
export interface SourceScore {
  source: ScoreSource;
  homeScore: number;
  awayScore: number;
  /**
   * Half-time score snapshot (populated once the 1H→2H transition is
   * observed). `undefined` means "not known yet" — e.g. match is
   * still in 1H, or the source doesn't expose HT. Zero is a real
   * score: 0-0 at HT.
   */
  htHome?: number;
  htAway?: number;
  minute: number;
  period: string;
  homeRedCards?: number;
  awayRedCards?: number;
  homeCorners?: number;
  awayCorners?: number;
  updatedAt: number;
  version?: number; // For conflict resolution (Pinnacle)
}

/**
 * Multi-source score container
 */
export interface MultiSourceScore {
  /** Primary score (best confidence) */
  primary: SourceScore | null;
  /** All source scores by provider */
  sources: Partial<Record<ScoreSource, SourceScore>>;
  /** Overall confidence in the score */
  confidence: ScoreConfidence;
  /** True if sources disagree on goals */
  hasDiscrepancy: boolean;
  /** Discrepancy details if any */
  discrepancy?: ScoreDiscrepancy;
  /** Normalized event ID */
  eventId: string;
  /** Last time any score was updated */
  lastUpdated: number;
}

/**
 * Discrepancy between score sources
 */
export interface ScoreDiscrepancy {
  /** Goal difference between sources */
  goalDifference: number;
  /** Sources involved */
  sources: ScoreSource[];
  /** When detected */
  detectedAt: number;
}

/**
 * Enhanced display score with multi-source info
 */
export interface MultiSourceDisplayScore extends DisplayScore {
  primarySource: ScoreSource;
  confidence: ScoreConfidence;
  hasDiscrepancy: boolean;
  alternativeScore?: {
    source: ScoreSource;
    home: number;
    away: number;
  };
}

/**
 * Convert BetConstruct state string to period
 */
export function bcStateToPeriod(state: string | undefined): string {
  switch (state?.toLowerCase()) {
    case "set1":
      return "1H";
    case "half time":
      return "HT";
    case "set2":
      return "2H";
    case "finished":
      return "FT";
    case "notstarted":
      return "PRE";
    default:
      return state || "LIVE";
  }
}
