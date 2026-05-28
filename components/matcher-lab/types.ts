export type MatchPairStage = "inbox" | "human_review" | "history";

export type MatchPairDecision =
  | "auto-merge"
  | "auto-reject"
  | "human-merge"
  | "human-reject"
  | "ai-merge"
  | "ai-reject";

export type MatchPairDecidedBy =
  | "ml-bi-encoder"
  | "ml-cross-encoder"
  | "ai-search"
  | "human"
  | "gemini-lite"
  | "gemini-flash"
  | "gemini-pro";

export interface MatchPairRow {
  id: string;
  stage: string;
  eventAProvider: string;
  eventAHomeTeam: string;
  eventAAwayTeam: string;
  eventACompetition: string;
  eventAStartTime: string;
  eventAEventId: string | null;
  eventBProvider: string;
  eventBHomeTeam: string;
  eventBAwayTeam: string;
  eventBCompetition: string;
  eventBStartTime: string;
  eventBEventId: string | null;
  stringScore: number;
  stringBreakdown: unknown;
  mlHomeCosine: number | null;
  mlAwayCosine: number | null;
  mlCompCosine: number | null;
  mlCombinedScore: number | null;
  mlScoredAt: string | null;
  mlModelVersion: string | null;
  xeScore: number | null;
  xePvalue: number | null;
  xeScoredAt: string | null;
  decision: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  resolutionSource: string | null;
  pairKey: string;
  detectedAt: string;
  stageChangedAt: string;
  source: string;
}

export interface StageCounts {
  inbox: number;
  human_review: number;
  history: number;
}

export interface MlSchedulerStats {
  active: boolean;
  processing: boolean;
  intervalMs: number;
  lastRunAt: string | null;
  lastBatchSize: number;
  totalProcessed: number;
}

export interface MlRunHistoryEntry {
  runAt: string;
  durationMs: number;
  processed: number;
  merged: number;
  rejected: number;
  escalated: number;
  aiSearchAttempted: number;
  aiSearchMerged: number;
  aiSearchRejected: number;
  status:
    | "success"
    | "empty"
    | "service_unreachable"
    | "already_running"
    | "disabled"
    | "service_error";
  trigger: "scheduler" | "manual";
}

export interface ResolutionSourceStat {
  source: string;
  count: number;
}

export interface MatcherConfigResponse {
  enabled: boolean;
  intervalMs: number;
  teamMergeThreshold: number;
  compMergeThreshold: number;
  combinedMergeThreshold: number;
  combinedRejectThreshold: number;
  xeEscalationEnabled: boolean;
  xeMergeThreshold: number;
  xePvalueThreshold: number;
  aiSearchEnabled: boolean;
  aiSearchConfidenceThreshold: number;
  aiSearchMaxBatchSize: number;
}

export interface StatsResponse {
  stageCounts: StageCounts;
  resolutionSources: ResolutionSourceStat[];
  mlStats: MlSchedulerStats;
  history: MlRunHistoryEntry[];
  historyTotal: number;
  hasMoreHistory: boolean;
  config: MatcherConfigResponse | null;
}

export interface ListResponse {
  rows: MatchPairRow[];
  stage: string;
  limit: number;
  offset: number;
}

export type AiVerificationJobStatus = "running" | "completed" | "failed";
export type AiVerificationResultStatus = "success" | "error";
export type AiVerificationDecision =
  | "SAME"
  | "DIFFERENT"
  | "UNCERTAIN"
  | "ERROR";

export interface AiVerificationJobResult {
  id: string;
  pair: MatchPairRow;
  status: AiVerificationResultStatus;
  decision: AiVerificationDecision;
  confidence: number | null;
  model: string | null;
  engine: "ai-search";
  reasoning: string;
  sources: { url: string; title: string; snippet: string }[];
  searchQueriesUsed: string[];
  error?: string;
}

export interface AiVerificationJobSnapshot {
  id: string;
  pairIds: string[];
  status: AiVerificationJobStatus;
  engine: "ai-search";
  model: "flash";
  total: number;
  processed: number;
  same: number;
  different: number;
  uncertain: number;
  errors: number;
  results: AiVerificationJobResult[];
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface StartAiVerificationJobResponse {
  job: AiVerificationJobSnapshot;
  reused: boolean;
}

export interface MlBatchResult {
  status:
    | "success"
    | "empty"
    | "service_unreachable"
    | "already_running"
    | "disabled"
    | "service_error";
  processed: number;
  merged: number;
  rejected: number;
  escalated: number;
  aiSearchAttempted?: number;
  aiSearchMerged?: number;
  aiSearchRejected?: number;
}

export const STAGE_META: Record<
  MatchPairStage,
  { label: string; tooltip: string; color: string; bgActive: string }
> = {
  inbox: {
    label: "Inbox",
    tooltip:
      "Near-matches (70–85% similarity) and unmatched cross-provider pairs land here from each sync cycle. They wait for the ML batch scorer to pick them up.",
    color: "text-amber-300",
    bgActive: "bg-amber-500/15 border-amber-500/30",
  },

  human_review: {
    label: "Human Review",
    tooltip:
      "The bi-encoder scored these but wasn't confident enough to decide automatically (combined score 0.50–0.88). You decide: merge, reject, or run DeepSeek for a second opinion.",
    color: "text-violet-300",
    bgActive: "bg-violet-500/15 border-violet-500/30",
  },
  history: {
    label: "History",
    tooltip:
      "All resolved pairs with a full audit trail — who decided, when, and the ML scores. Pruned after 30 days.",
    color: "text-zinc-400",
    bgActive: "bg-zinc-700/50 border-zinc-600/30",
  },
};

export type MlProgressEventType =
  | "batch_start"
  | "transitioning"
  | "embedding"
  | "embedding_done"
  | "pair_scoring"
  | "pair_decided"
  | "service_unreachable"
  | "batch_complete";

export interface MlProgressEvent {
  type: MlProgressEventType;
  pairId?: string;
  index?: number;
  total?: number;
  verdict?: string;
  score?: number;
  merged?: number;
  rejected?: number;
  escalated?: number;
  processed?: number;
  durationMs?: number;
  aiSearchAttempted?: number;
  aiSearchMerged?: number;
  aiSearchRejected?: number;
}

export type PairProcessingStatus =
  | "idle"
  | "queued"
  | "embedding"
  | "scoring"
  | "ai-searching"
  | "ai-same"
  | "ai-different"
  | "merged"
  | "rejected"
  | "escalated"
  | "error";

export const PROVIDER_BADGE: Record<
  string,
  { label: string; className: string }
> = {
  pinnacle: {
    label: "PIN",
    className: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  },
  "ninewickets-exchange": {
    label: "9WX",
    className: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  },
  "ninewickets-sportsbook": {
    label: "9WS",
    className: "bg-teal-500/20 text-teal-300 border-teal-500/30",
  },
  betconstruct: {
    label: "BC",
    className: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  },
  "velki-sportsbook": {
    label: "VLK",
    className: "bg-orange-500/20 text-orange-300 border-orange-500/30",
  },
};

export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  pinnacle: "Pinnacle",
  "ninewickets-exchange": "NineWickets Exchange",
  "ninewickets-sportsbook": "NineWickets Sportsbook",
  betconstruct: "BetConstruct",
  "velki-sportsbook": "Velki Sportsbook",
};

export const DECISION_COLORS: Record<string, string> = {
  "auto-merge": "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  "auto-reject": "bg-red-500/15 text-red-300 border-red-500/30",
  "human-merge": "bg-emerald-600/20 text-emerald-200 border-emerald-600/40",
  "human-reject": "bg-red-600/20 text-red-200 border-red-600/40",
  "ai-merge": "bg-sky-500/15 text-sky-300 border-sky-500/30",
  "ai-reject": "bg-rose-500/15 text-rose-300 border-rose-500/30",
};
