import type { ValueBetRow } from "./types";

export type ListFilters = {
  from?: string;
  to?: string;
  eventFrom?: string;
  eventTo?: string;
  marketTypes?: string[];
  softProviders?: string[];
  settledBySources?: string[];
  outcome?: string;
  minEv?: number;
  maxEv?: number;
  search?: string;
  readyToSettle?: boolean;
  needsReview?: boolean;
  placedOnly?: boolean;
  preMatchOnly?: boolean;
  oddsMin?: number;
  oddsMax?: number;
  minSharpProb?: number;

  minTickCount?: number;
  mode?: "auto" | "manual";
  limit?: number;
  offset?: number;
};

export type ListResponse = {
  rows: ValueBetRow[];
  total: number;
  limit: number;
  offset: number;
};

export type Outcome =
  | "pending"
  | "won"
  | "half_won"
  | "lost"
  | "half_lost"
  | "void";

export type SettlementProposal = {
  id: string;
  proposedOutcome: Outcome;
  confidence: number;
  reasoning: string;
  score: string;
  tier: "pure" | "unresolved";
  source: string | null;
};

export type SettlementProposalError = { id: string; error: string };

export type SettlementTelemetry = {
  total: number;
  tier0_hits: number;
  tier1_hits: number;
  tier2_hits: number;
  tier3_hits: number;
  tier4_hits: number;
  unresolved: number;
  durationMs: number;
  eventsTotal: number;
  eventsAttempted: number;
  eventsSkippedByBackoff: number;
  eventsResolvedFromCache: number;
  eventsResolvedByEspn: number;
  eventsResolvedBySofaScore: number;
  eventsResolvedByApiFootball: number;
  eventsStillUnresolved: number;
  apiFootballRequestsUsed: number;
  settledDeterministically: number;
  unsupported: number;
  unresolvedEvents: number;
};

export type SettlementResponse = {
  proposals: Array<SettlementProposal | SettlementProposalError>;
  attempted: number;
  missing: string[];
  includedRows?: ValueBetRow[];
  expandedIds?: string[];
  telemetry?: SettlementTelemetry;
  unresolvedEventCount?: number;
};

export type AiAnalysis = {
  summary: string;
  patterns: string[];
  concerns: string[];
  recommendations: string[];
  by_market: {
    market: string;
    total: number;
    wins: number;
    losses: number;
    voids: number;
    pending: number;
  }[];
  model: string;
};

export type AiAnalyzeResponse = {
  analysis: AiAnalysis;
  analyzed: number;
};

type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };

const unwrap = async <T>(res: Response): Promise<T> => {
  const body = (await res.json()) as ApiEnvelope<T>;
  if (!body.ok) throw new Error(body.error);
  return body.data;
};

const toQuery = (filters: ListFilters): string => {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v === undefined || v === null || v === "") return;
    if (Array.isArray(v)) {
      if (v.length === 0) return;
      params.set(k, v.join(","));
      return;
    }
    params.set(k, String(v));
  });
  const s = params.toString();
  return s ? `?${s}` : "";
};

export const listValueBets = async (
  filters: ListFilters,
): Promise<ListResponse> => {
  const res = await fetch(`/api/bets${toQuery(filters)}`, {
    credentials: "include",
  });
  return unwrap<ListResponse>(res);
};

export type BetsStatsResponse = {
  matched: number;
  settled: number;
  pending: number;
  placed: number;
  placedSettled: number;
  placedPending: number;
  wins: number;
  halfWins: number;
  losses: number;
  halfLosses: number;
  voids: number;
  flat: { stake: number; pnl: number; roiPct: number; winRatePct: number };
  real: {
    stake: number;
    pnl: number;
    roiPct: number;
    winRatePct: number;
    openStake: number;
  };
};

export const fetchBetsStats = async (
  filters: ListFilters,
): Promise<BetsStatsResponse> => {
  const { limit: _l, offset: _o, ...rest } = filters;
  const res = await fetch(`/api/bets/stats${toQuery(rest)}`, {
    credentials: "include",
  });
  return unwrap<BetsStatsResponse>(res);
};

export const markOutcome = async (
  id: string,
  outcome: Outcome,
): Promise<ValueBetRow> => {
  const res = await fetch(`/api/bets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outcome }),
  });
  const data = await unwrap<{ row: ValueBetRow }>(res);
  return data.row;
};

export const deleteBet = async (id: string): Promise<void> => {
  const res = await fetch(`/api/bets/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  await unwrap<{ deleted: boolean }>(res);
};

export type BulkUpdate = {
  id: string;
  outcome: Outcome;
  source?: string | null;
  score?: string | null;
};

export const bulkMarkOutcomes = async (
  updates: BulkUpdate[],
): Promise<{ applied: number; attempted: number; skipped: number }> => {
  const res = await fetch(`/api/bets/outcomes`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates }),
  });
  return unwrap(res);
};

export type ModelTier = "lite" | "flash" | "pro";

export const settleBets = async (
  ids: string[],
  opts?: {
    bypassCache?: boolean;
  },
): Promise<SettlementResponse> => {
  const res = await fetch(`/api/bets-history/settle`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ids,
      ...(opts?.bypassCache === undefined
        ? {}
        : { bypassCache: opts.bypassCache }),
    }),
  });
  return unwrap(res);
};

export const aiAnalyzeBets = async (payload: {
  ids?: string[];
  filters?: ListFilters;
  model?: ModelTier;
}): Promise<AiAnalyzeResponse> => {
  const body = payload.ids
    ? { ids: payload.ids, model: payload.model ?? "flash" }
    : { filters: payload.filters ?? {}, model: payload.model ?? "flash" };
  const res = await fetch(`/api/bets-history/ai-analyze`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return unwrap(res);
};


export type ProposeRuleFilters = {
  marketTypes?: string[];
  softProviders?: string[];
  minEv?: number;
  maxEv?: number;
  tickMin?: number;
  oddsMin?: number;
  oddsMax?: number;
  timeScope?: string;
  competition?: string;
  atomId?: string;
};

export type ProposedRule = {
  ruleId: string;
  rationale: string;
  filters: ProposeRuleFilters;
  stakeMultiplier: number;
  expectedEdgePct: number;
  confidence: "low" | "medium" | "high";
  knownRisks: string[];
};

export type ProposeResponse = {
  rules: ProposedRule[];
  model: string;
};

export type ProposeSliceInput = {
  label: string;
  dimensions: Record<string, string>;
  n: number;
  wins: number;
  losses: number;
  roiPct: number | null;
  shrunkRoiPct: number | null;
  clvPct: number | null;
  avgEvPct: number;
  z: number | null;
  pAdj: number | null;
};

export type ProposeHeadlineInput = {
  totalRows: number;
  settledRows: number;
  winRatePct: number | null;
  flatRoiPct: number | null;
  meanClvPct: number | null;
  beatCloseRatePct: number | null;
  brier: number | null;
};

export const aiProposeRules = async (payload: {
  topSlices: ProposeSliceInput[];
  headline: ProposeHeadlineInput;
  maxRules?: number;
}): Promise<ProposeResponse> => {
  const res = await fetch(`/api/bets-history/ai-propose`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return unwrap(res);
};

export type BetsHistoryRuleResult = {
  oosTotal: number;
  oosCutoffFirstSeenAt: string | null;
  n: number;
  wins: number;
  losses: number;
  voids: number;
  pushes: number;
  pendings: number;
  winRatePct: number | null;
  roiPct: number | null;
  avgEvPct: number;
  clvPct: number | null;
  beatCloseRatePct: number | null;
  z: number | null;
  p: number | null;
};

export const betsHistoryRule = async (payload: {
  filters: ProposeRuleFilters;
  oosFraction?: number;
}): Promise<BetsHistoryRuleResult> => {
  const res = await fetch(`/api/settlement/rules`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return unwrap(res);
};


export type SettlementActivityLevel = "debug" | "info" | "warn" | "error";
export type SettlementActivityKind =
  | "tick:start"
  | "tick:end"
  | "tick:error"
  | "tick:skipped"
  | "state:start"
  | "state:stop"
  | "state:pause"
  | "state:resume"
  | "state:disable"
  | "state:enable"
  | "manual:run"
  | "source:degraded"
  | "note";

export type SettlementActivityEntry = {
  id: string;
  ts: number;
  level: SettlementActivityLevel;
  kind: SettlementActivityKind;
  message: string;
  data?: Record<string, unknown>;
};

export type SettlementRunRowApi = {
  id: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scannedBets: number;
  uniqueEvents: number;
  settledDeterministically: number;
  applied: number;
  stillPending: number;
  tier0Hits: number;
  tier1Hits: number;
  tier2Hits: number;
  tier3Hits: number;
  tier4Hits: number;
  unresolvedEvents: number;
  eventsTotal: number;
  eventsAttempted: number;
  eventsSkippedByBackoff: number;
  eventsResolvedFromCache: number;
  eventsResolvedByEspn: number;
  eventsResolvedBySofaScore: number;
  eventsResolvedByApiFootball: number;
  eventsStillUnresolved: number;
  apiFootballRequestsUsed: number;
  abortedReason: string | null;
  error: string | null;
  estimatedCostUsd: number;
};

export type SettlementStatus = {
  active: boolean;
  paused: boolean;
  intervalMs: number;
  tickInFlight: boolean;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  totalTicks: number;
  totalApplied: number;
  skippedTicks: number;
  lastResult: {
    scannedBets: number;
    settled: number;
    stillPending: number;
    applied: number;
    errors: string[];
    sourceIssues?: string[];
  } | null;
  queuedCount: number;
  recentRuns: SettlementRunRowApi[];
  activity: SettlementActivityEntry[];
};

export type SettlementAction =
  | "run"
  | "start"
  | "stop"
  | "restart"
  | "pause"
  | "resume";

export const getSettlementStatus = async (opts?: {
  runs?: number;
  log?: number;
}): Promise<SettlementStatus> => {
  const params = new URLSearchParams();
  if (opts?.runs !== undefined) params.set("runs", String(opts.runs));
  if (opts?.log !== undefined) params.set("log", String(opts.log));
  const qs = params.toString();
  const res = await fetch(`/api/settlement${qs ? `?${qs}` : ""}`, {
    credentials: "include",
  });
  return unwrap<SettlementStatus>(res);
};

export const postSettlementAction = async (
  action: SettlementAction,
  opts?: { intervalMs?: number },
): Promise<unknown> => {
  const res = await fetch(`/api/settlement`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...(opts ?? {}) }),
  });
  return unwrap(res);
};
