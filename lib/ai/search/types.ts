export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Full provider-returned text when available; falls back to snippet. */
  content?: string;
  source: string;
  score?: number;
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
}

export interface SourceCitation {
  url: string;
  title: string;
  snippet: string;
}

export type MatchDecision = "SAME" | "DIFFERENT" | "UNCERTAIN";

export interface AiParseDiagnostics {
  parseStatus: "valid" | "recovered" | "invalid";
  finishReason?: string;
  warning?: string;
}

export interface MatchVerdict {
  decision: MatchDecision;
  confidence: number;
  reasoning: string;
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
