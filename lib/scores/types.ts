
export interface LiveScore {
  eventId: string;
  homeScore: number;
  awayScore: number;
  htHome?: number;
  htAway?: number;
  elapsed: number;
  state: number;
  homeRedCards: number;
  awayRedCards: number;
  resultingUnit: string;
  version: number;
  updatedAt: number;
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

export interface CornersScore {
  eventId: string;
  homeCorners: number;
  awayCorners: number;
  version: number;
  updatedAt: number;
}

export interface DisplayScore {
  home: number;
  away: number;
  minute: number;
  period: string;
  homeRedCards: number;
  awayRedCards: number;
}

export function stateToPeriod(state: number, elapsed: number): string {
  switch (state) {
    case 1:
      return elapsed <= 45 ? "1H" : "HT";
    case 2:
      return "2H";
    case 3:
      return "ET";
    case 4:
      return "PEN";
    case 0:
    default:
      return elapsed > 0 ? "LIVE" : "PRE";
  }
}

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


export type ScoreSource = "pinnacle" | "betconstruct";

export type ScoreConfidence = "high" | "medium" | "low" | "stale";

export interface SourceScore {
  source: ScoreSource;
  homeScore: number;
  awayScore: number;
  htHome?: number;
  htAway?: number;
  minute: number;
  period: string;
  homeRedCards?: number;
  awayRedCards?: number;
  homeCorners?: number;
  awayCorners?: number;
  updatedAt: number;
  version?: number;
}

export interface MultiSourceScore {
  primary: SourceScore | null;
  sources: Partial<Record<ScoreSource, SourceScore>>;
  confidence: ScoreConfidence;
  hasDiscrepancy: boolean;
  discrepancy?: ScoreDiscrepancy;
  eventId: string;
  lastUpdated: number;
}

export interface ScoreDiscrepancy {
  goalDifference: number;
  sources: ScoreSource[];
  detectedAt: number;
}

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
