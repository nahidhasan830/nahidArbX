import type {
  EventMatcherConfig,
  EventMatcherProgressEvent,
  EventMatcherReliabilityStats,
  EventMatcherRunSummary,
  ScoreBreakdown,
} from "@/lib/event-matcher/types";

export interface MatcherDecisionEvent {
  id: string;
  provider: string;
  providerEventId: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  kickoff: string;
  rawStartTime: string | null;
  parseStrategy: string;
  providerMetadata: Record<string, unknown> | null;
}

export interface MatcherDecisionRow {
  decisionId: string;
  runId: string;
  candidateId: string;
  shapeFingerprint: string;
  scoringVersion: string;
  groundingVersion: string;
  decision: "auto_merge" | "auto_reject" | "human_review";
  decisionStage:
    | "hard_block"
    | "deterministic"
    | "embedding"
    | "deepseek"
    | "human_review";
  confidence: number;
  confidenceBand: string;
  final: boolean;
  dryRun: boolean;
  reasonCode: string;
  reasonSummary: string;
  groundedDecision: "SAME" | "DIFFERENT" | "UNCERTAIN" | null;
  groundedConfidence: number | null;
  hardBlockers: string[];
  scoreBreakdown: ScoreBreakdown;
  createdAt: string;
  providerA: string;
  providerB: string;
  candidateKey: string;
  sourceStage: string;
  combinedScore: number | null;
  eventA: MatcherDecisionEvent;
  eventB: MatcherDecisionEvent;
}

export interface MatcherListResponse {
  rows: MatcherDecisionRow[];
  runId?: string;
  decision?: string;
  limit: number;
  offset: number;
  total: number;
  decisionCounts: { decision: string; count: number }[];
}

export interface MatcherStatsResponse {
  config: EventMatcherConfig;
  decisionCounts: { decision: string; count: number }[];
  reviewCount: number;
  reliability: EventMatcherReliabilityStats;
}

export type MatcherRunRequest = {
  mode: "apply";
  decisionIds?: string[];
  useDeepSeek?: boolean;
};

export type MatcherRunResponse = EventMatcherRunSummary;

export type MatcherRunProgressEvent = EventMatcherProgressEvent;

export type MatcherRunJobStatus = "queued" | "running" | "completed" | "failed";

export interface MatcherRunJob {
  id: string;
  status: MatcherRunJobStatus;
  trigger: string;
  mode: "apply";
  decisionIds: string[];
  useDeepSeek: boolean | null;
  summary: MatcherRunResponse | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  events: MatcherRunProgressEvent[];
}

export interface MatcherRunJobResponse {
  job: MatcherRunJob | null;
}

export type MatcherManualDecision =
  | "auto_merge"
  | "auto_reject"
  | "human_review";

export interface MatcherSchedulerSettingsRow {
  id: number;
  enabled: boolean;
  intervalSeconds: number;
  useDeepSeek: boolean;
  updatedAt: string;
}

export interface MatcherSchedulerSettingsResponse {
  row: MatcherSchedulerSettingsRow;
  ready: boolean;
  error?: string;
}

export const PROVIDER_BADGE: Record<
  string,
  { label: string; className: string }
> = {
  pinnacle: {
    label: "PIN",
    className: "border-blue-500/25 bg-blue-500/10 text-blue-300",
  },
  "ninewickets-exchange": {
    label: "9WX",
    className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
  },
  "ninewickets-sportsbook": {
    label: "9WS",
    className: "border-teal-500/25 bg-teal-500/10 text-teal-300",
  },
  betconstruct: {
    label: "BC",
    className: "border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-300",
  },
  "velki-sportsbook": {
    label: "VLK",
    className: "border-orange-500/25 bg-orange-500/10 text-orange-300",
  },
  "saba-sportsbook": {
    label: "SABA",
    className: "border-cyan-500/25 bg-cyan-500/10 text-cyan-300",
  },
};

export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  pinnacle: "Pinnacle",
  "ninewickets-exchange": "NineWickets Exchange",
  "ninewickets-sportsbook": "NineWickets Sportsbook",
  betconstruct: "BetConstruct",
  "velki-sportsbook": "Velki Sportsbook",
  "saba-sportsbook": "Saba Sportsbook",
};

export const DECISION_META: Record<
  MatcherDecisionRow["decision"],
  { label: string; className: string; description: string }
> = {
  auto_merge: {
    label: "Auto merge",
    className: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
    description: "Final merge accepted by deterministic or scoring policy.",
  },
  auto_reject: {
    label: "Auto reject",
    className: "border-red-500/25 bg-red-500/10 text-red-300",
    description: "Final reject accepted by hard blockers or low score.",
  },
  human_review: {
    label: "Needs review",
    className: "border-zinc-500/30 bg-zinc-500/10 text-zinc-300",
    description:
      "Ambiguous candidate or operational fallback that requires operator review.",
  },
};
