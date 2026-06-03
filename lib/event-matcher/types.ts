import type { NormalizedEvent } from "../types";
import type { SourceBackedAliasEvidence } from "../ai/search/types";

export type EventMatcherMode = "apply";
export type EventMatcherTrigger = "manual" | "cron" | "api" | "test";
export type EventMatcherDecision =
  | "auto_merge"
  | "auto_reject"
  | "human_review";
export type EventMatcherStage =
  | "hard_block"
  | "deterministic"
  | "embedding"
  | "deepseek"
  | "human_review";

export interface EventMatcherConfig {
  sameProviderBlocked: boolean;
  scoringVersion: string;
  groundingVersion: string;
  candidateLlmAdmitTeamFloor: number;
  teamAutoMergeFloor: number;
  teamAutoRejectCeiling: number;
  competitionAutoMergeFloor: number;
  competitionRejectCeiling: number;
  combinedAutoMergeThreshold: number;
  combinedAutoRejectThreshold: number;
  residualLow: number;
  residualHigh: number;
  deepseekEnabled: boolean;
  deepseekAutoMergeEnabled: boolean;
  deepseekAutoMergeConfidence: number;
  deepseekConsensusAutoMergeConfidence: number;
  deepseekAutoRejectConfidence: number;
  embeddingEnabled: boolean;
}

export interface ProviderSnapshotInput {
  event: NormalizedEvent;
  provider: string;
  providerEventId: string;
  fetchedAt?: Date;
  fetchBatchId: string;
  rawStartTime?: string | null;
  parseStrategy?: string;
  providerMetadata?: Record<string, unknown> | null;
  rawPayload?: unknown;
}

export interface ProviderEventSnapshot {
  id: string;
  provider: string;
  providerEventId: string;
  sport: string;
  homeTeamRaw: string;
  awayTeamRaw: string;
  competitionRaw: string;
  homeTeamNormalized: string;
  awayTeamNormalized: string;
  competitionNormalized: string;
  rawStartTime: string | null;
  parsedKickoff: Date;
  parseStrategy: string;
  fetchBatchId: string;
  providerMetadata: Record<string, unknown> | null;
  rawPayload: unknown;
  capturedAt?: Date;
}

export interface EventMatcherCandidate {
  id: string;
  runId: string;
  snapshotA: ProviderEventSnapshot;
  snapshotB: ProviderEventSnapshot;
  candidateKey: string;
  shapeFingerprint: string;
  scoringVersion: string;
  groundingVersion: string;
  hardBlockers: string[];
  reasons: string[];
  admission: "hard_admit" | "llm_admit";
  sourceStage: string;
}

export interface ScoreBreakdown {
  home: number;
  away: number;
  swappedHome: number;
  swappedAway: number;
  sameOrientationTeam: number;
  swappedOrientationTeam: number;
  bestTeam: number;
  orientation: "same" | "swapped";
  competition: number;
  kickoff: number;
  kickoffExact: boolean;
  providerReliability: number;
  alias: number;
  metadata: number;
  embeddingTeam: number | null;
  embeddingCompetition: number | null;
  combined: number;
  diagnostics: {
    exactKickoff: boolean;
    providerPair: string;
    providerHints: string[];
  };
}

export interface EventMatcherPolicyDecision {
  decision: EventMatcherDecision;
  stage: EventMatcherStage;
  confidence: number;
  confidenceBand: string;
  final: boolean;
  reasonCode: string;
  reasonSummary: string;
  groundedDecision?: DeepSeekResidualDecision["decision"] | null;
  groundedConfidence?: number | null;
}

export interface DeepSeekCanonicalEvent {
  home: string | null;
  away: string | null;
  competition: string | null;
  kickoff: string | null;
}

export interface DeepSeekResidualDecision {
  decision: "SAME" | "DIFFERENT" | "UNCERTAIN";
  confidence: number;
  reasoning: string;
  canonicalEvent: DeepSeekCanonicalEvent | null;
  confirmedFacts: string[];
  uncertainties: string[];
  evidenceAssessment: {
    sameEvidence: number;
    differentEvidence: number;
    contradiction: boolean;
    noSource: boolean;
    notes: string[];
  } | null;
  aliasEvidence?: SourceBackedAliasEvidence[];
  sources: Array<{ url: string; title: string; snippet: string }>;
  searchQueriesUsed: string[];
  model: string;
  diagnostics?: unknown;
}

export interface EventMatcherRunOptions {
  trigger: EventMatcherTrigger;
  mode?: EventMatcherMode;
  fetchBatchId?: string;
  decisionIds?: string[];
  applyMerges?: boolean;
  useDeepSeek?: boolean;
  groundedReviewSkipReason?: "disabled" | "degraded";
  groundedReviewDegradationReason?: string | null;
  onProgress?: (event: EventMatcherProgressEvent) => void | Promise<void>;
}

export interface EventMatcherRunSummary {
  id: string;
  mode: EventMatcherMode;
  status: "completed" | "failed";
  snapshotCount: number;
  candidateCount: number;
  generatedCandidateCount?: number;
  skippedCandidateCount?: number;
  autoMerged: number;
  autoRejected: number;
  deepseekReviewed: number;
  humanReview: number;
  durationMs: number;
  errorMessage?: string;
}

export interface EventMatcherReliabilityStats {
  windowSize: number;
  deepseekReviewed: number;
  deepseekResolved: number;
  deepseekUnavailable: number;
  groundedReviewSkipped: number;
  groundedReviewDisabled: number;
  groundedReviewDegraded: number;
  groundedReviewCapReached: number;
  searchFailure: number;
  noSource: number;
  contradictorySource: number;
  uncertain: number;
  autoMerge: number;
  autoReject: number;
  humanFallback: number;
  clusterConflicts: number;
  noSourceRate: number;
  searchFailureRate: number;
  contradictorySourceRate: number;
  unavailableRate: number;
  humanFallbackRate: number;
  healthy: boolean;
  degradationReason: string | null;
}

export interface EventMatcherClusterSummary {
  canonicalEventId: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  kickoff: string;
  memberCount: number;
  providers: string[];
  competitionVariants: string[];
  latestDecisionAt: string | null;
  latestSupport: {
    decision: EventMatcherDecision;
    decisionStage: EventMatcherStage;
    confidence: number;
    reasonCode: string;
  } | null;
}

export type EventMatcherProgressPhase =
  | "initializing"
  | "loading_snapshots"
  | "generating_candidates"
  | "filtering_candidates"
  | "scoring_candidates"
  | "reviewing_residual"
  | "writing_decision"
  | "applying_merge"
  | "rebuilding_impact"
  | "completed"
  | "failed";

export interface EventMatcherProgressCounters {
  snapshots: number;
  generatedCandidates: number;
  candidatesToScore: number;
  skippedCandidates: number;
  scoredCandidates: number;
  insertedCandidates: number;
  autoMerged: number;
  autoRejected: number;
  deepseekReviewed: number;
  humanReview: number;
}

export interface EventMatcherProgressEvent {
  runId: string;
  mode: EventMatcherMode;
  phase: EventMatcherProgressPhase;
  message: string;
  timestamp: string;
  elapsedMs: number;
  counters: EventMatcherProgressCounters;
  candidate?: {
    key: string;
    providerA: string;
    providerB: string;
    homeA: string;
    awayA: string;
    homeB: string;
    awayB: string;
    kickoffA: string;
    kickoffB: string;
  };
  score?: {
    combined: number;
    team: number;
    competition: number;
    kickoff: number;
  };
  decision?: {
    value: EventMatcherDecision;
    stage: EventMatcherStage;
    confidence: number;
    reason: string;
  };
  errorMessage?: string;
  summary?: EventMatcherRunSummary;
}
