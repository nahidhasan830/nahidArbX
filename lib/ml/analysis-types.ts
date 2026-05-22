export type ModelStance = "skip" | "shrink" | "agree" | "boost";

export type AnalysisSeverity = "critical" | "warning" | "neutral" | "positive";

export type FactorTone = "positive" | "negative" | "neutral";

export type EdgeTier =
  | "negative_edge_deep"
  | "negative_edge_moderate"
  | "negative_edge_mild"
  | "positive_edge_moderate"
  | "positive_edge_strong"
  | "positive_edge_deep";

export type AnalysisBucket =
  | EdgeTier
  | "persistence"
  | "steam"
  | "convergence"
  | "no_signal";

export type AnalysisSignal = "steam" | "persistence" | "convergence_fading";

export interface AnalysisBetSummary {
  id: string;
  homeTeam: string | null;
  awayTeam: string | null;
  competition: string | null;
  marketType: string | null;
  softOdds: number;
  mlScore: number | null;
}

export interface AnalysisDecision {
  type: ModelStance;
  multiplier: number;
  icon: string;
  label: string;
}

export interface StorySection {
  severity: AnalysisSeverity;
  emoji: string;
  title: string;
  paragraphs: string[];
  dollarImpact?: {
    perDollar: number;
    over100Bets: number;
  };
}

export interface NumbersSection {
  modelEdge: number;
  modelEdgeFormatted: string;
  modelScore: number;
  modelScoreFormatted: string;
  odds: number;
  impliedProbability: number;
  gap: number;
  gapFormatted: string;
  factors: {
    name: string;
    value: string;
    detail: string;
    tone: FactorTone;
  }[];
}

export interface ConfidenceSection {
  stars: 1 | 2 | 3 | 4 | 5;
  label: string;
  reasons: string[];
}

export interface TrackRecordSection {
  bucket: AnalysisBucket;
  bucketLabel: string;
  wins: number;
  losses: number;
  total: number;
  winRate: number;
  unitPnl: number;
  unitPnlFormatted: string;
  avgEdge: number;
  avgEdgeFormatted: string;
  note: string;
}

export interface SimilarBetRow {
  id: string;
  eventId: string;
  homeTeam: string | null;
  awayTeam: string | null;
  competition: string | null;
  eventStartTime: string | null;
  outcome: string;
  softOdds: number | null;
  unitPnl: number;
  unitPnlFormatted: string;
  modelEdge: number;
  modelEdgeFormatted: string;
  firstSeenAt: string | null;
  marketType: string | null;
}

export interface AnalysisResponse {
  bet: AnalysisBetSummary;
  decision: AnalysisDecision;
  story: StorySection;
  numbers: NumbersSection;
  confidence: ConfidenceSection;
  trackRecord: TrackRecordSection;
  similarBets: SimilarBetRow[];
}
