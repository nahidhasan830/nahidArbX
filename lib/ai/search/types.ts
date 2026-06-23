export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  source: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface ProviderStats {
  name: string;
  healthy: boolean;
  enabled: boolean;
  requestsUsed: number;
  quotaLimit: number | null;
  quotaRemaining: number | null;
  quotaSource: "db" | "live" | "local" | "none";
  lastError: string | null;
  lastUsedAt: string | null;
}

export interface EventInfo {
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startTime: string;
  provider?: string;
  normalized?: {
    homeTeam: string;
    awayTeam: string;
    competition: string;
  };
  providerMetadata?: Record<string, unknown> | null;
  matcherContext?: {
    candidateKey?: string;
    reasons?: string[];
    scoreBreakdown?: unknown;
    canonicalMembership?: unknown;
  };
}

export interface SourceCitation {
  url: string;
  title: string;
  snippet: string;
}

export interface EvidenceAssessment {
  sameEvidence: number;
  differentEvidence: number;
  contradiction: boolean;
  noSource: boolean;
  notes: string[];
}

export interface SourceBackedAliasEvidence {
  side: "home" | "away";
  eventASurface: string;
  eventBSurface: string;
  canonicalSurface: string;
  sourceTitle: string;
  sourceUrl: string;
  reason: string;
}

export type MatchDecision = "SAME" | "DIFFERENT" | "UNCERTAIN";

export interface MatchCanonicalEvent {
  home: string | null;
  away: string | null;
  competition: string | null;
  kickoff: string | null;
}

export interface AiParseDiagnostics {
  parseStatus: "valid" | "recovered" | "invalid";
  finishReason?: string;
  warning?: string;
  searchQueryCount?: number;
  searchFailureCount?: number;
  searchFailureRate?: number;
  searchProvidersUsed?: string[];
}

export interface MatchVerdict {
  decision: MatchDecision;
  confidence: number;
  reasoning: string;
  canonicalEvent: MatchCanonicalEvent | null;
  confirmedFacts: string[];
  uncertainties: string[];
  evidenceAssessment: EvidenceAssessment | null;
  aliasEvidence: SourceBackedAliasEvidence[];
  sources: SourceCitation[];
  searchQueriesUsed: string[];
  model: string;
  diagnostics?: AiParseDiagnostics;
}

export interface PairVerdict {
  pairIndex: number;
  decision: MatchDecision;
  confidence: number;
  reasoning: string;
  diagnostics?: AiParseDiagnostics;
}

export interface BatchMatchVerdict {
  verdicts: PairVerdict[];
  sources: SourceCitation[];
  searchQueriesUsed: string[];
  model: string;
}

export interface GroundedAnswer {
  answer: string;
  reasoning: string;
  sources: SourceCitation[];
  model: string;
}
