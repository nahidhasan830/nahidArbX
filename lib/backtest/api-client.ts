import type { ValueBetRow } from "./types";

export type ListFilters = {
  from?: string;
  to?: string;
  /** Multi-select market types. Empty/undefined = all. */
  marketTypes?: string[];
  /** Multi-select soft providers. Empty/undefined = all. */
  softProviders?: string[];
  /** Multi-select settlement sources (espn, sofascore, manual, …). */
  settledBySources?: string[];
  outcome?: string;
  minEv?: number;
  maxEv?: number;
  search?: string;
  /** Pending bets whose kickoff was ≥ 2h15m ago — ready for settlement. */
  readyToSettle?: boolean;
  /**
   * Bets the pipeline tried to settle but couldn't — needs human review.
   * (pending AND settle_attempts > 0). Partial-indexed server-side.
   */
  needsReview?: boolean;
  /**
   * Exclude historical in-play pollution (rows detected at or after kickoff).
   * Platform is pre-match only; see in-play.md.
   */
  preMatchOnly?: boolean;
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

/**
 * Result shape returned by `POST /api/backtest/ai-label` (the settlement
 * waterfall). Each proposal reports the tier that resolved the match and
 * the source it came from ("espn", "sofascore", "pinnacle-ws" …). "pure"
 * means the deterministic settler produced an outcome; "unresolved" means
 * no tier could provide a score — those rows fall back to manual verify.
 */
export type AiLabelResult = {
  id: string;
  proposedOutcome: Outcome;
  confidence: number;
  reasoning: string;
  /** Final score as `home-away`, scoped per market (FT / 1H / 2H). Empty when unknown. */
  score: string;
  tier: "pure" | "unresolved";
  source: string | null;
};

export type AiLabelError = { id: string; error: string };

export type SettlementTelemetry = {
  total: number;
  tier0_hits: number;
  tier1_hits: number;
  tier2_hits: number;
  tier3_hits: number;
  tier4_hits: number;
  unresolved: number;
  durationMs: number;
  settledDeterministically: number;
  unsupported: number;
  unresolvedEvents: number;
};

export type AiLabelResponse = {
  proposals: Array<AiLabelResult | AiLabelError>;
  attempted: number;
  missing: string[];
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
  const res = await fetch(`/api/backtest/value-bets${toQuery(filters)}`, {
    credentials: "include",
  });
  return unwrap<ListResponse>(res);
};

export const markOutcome = async (
  id: string,
  outcome: Outcome,
): Promise<ValueBetRow> => {
  const res = await fetch(
    `/api/backtest/value-bets/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome }),
    },
  );
  const data = await unwrap<{ row: ValueBetRow }>(res);
  return data.row;
};

export type BulkUpdate = {
  id: string;
  outcome: Outcome;
  /** Pipeline tier/source ("espn", "sofascore", "manual" …). */
  source?: string | null;
};

export const bulkMarkOutcomes = async (
  updates: BulkUpdate[],
): Promise<{ applied: number; attempted: number; skipped: number }> => {
  const res = await fetch(`/api/backtest/outcomes/bulk`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ updates }),
  });
  return unwrap(res);
};

export type ModelTier = "lite" | "flash" | "pro";

/**
 * Trigger the settlement waterfall for a set of bet IDs. The route no
 * longer needs a model tier — the pipeline is mostly free tiers; AI is
 * gated by the kill switch and configured server-side.
 */
/**
 * Trigger settlement for a set of bet IDs. Modes:
 *   - default                  → free waterfall only (cache → live → ESPN → SofaScore)
 *   - `{ useAi: true }`        → free waterfall + AI fallback for misses
 *   - `{ bypassCache: true }`  → re-run waterfall ignoring cached scores
 *   - `{ forceAi: true, aiModel }` → skip free tiers, go straight to AI
 */
export const aiLabelBets = async (
  ids: string[],
  opts?: {
    useAi?: boolean;
    bypassCache?: boolean;
    forceAi?: boolean;
    aiModel?: ModelTier;
  },
): Promise<AiLabelResponse> => {
  const res = await fetch(`/api/backtest/ai-label`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ids,
      useAi: opts?.useAi === true,
      bypassCache: opts?.bypassCache === true,
      forceAi: opts?.forceAi === true,
      aiModel: opts?.aiModel,
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
  const res = await fetch(`/api/backtest/ai-analyze`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return unwrap(res);
};

// ─────────────────────────────────────────────────────────────────
// Gemini rule proposal + held-out backtest
// ─────────────────────────────────────────────────────────────────

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
  const res = await fetch(`/api/backtest/ai-propose`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return unwrap(res);
};

export type BacktestRuleResult = {
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

export const backtestRule = async (payload: {
  filters: ProposeRuleFilters;
  oosFraction?: number;
}): Promise<BacktestRuleResult> => {
  const res = await fetch(`/api/backtest/backtest-rule`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return unwrap(res);
};

// ─────────────────────────────────────────────────────────────────
// Strategies
// ─────────────────────────────────────────────────────────────────

export type StrategySummary = {
  strategyId: string;
  totalExecutions: number;
  settled: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  roiPct: number | null;
  clvPct: number | null;
};

export type Strategy = {
  id: string;
  name: string;
  description: string | null;
  filters: ListFilters;
  stakeMultiplier: number;
  origin: "manual" | "ai";
  rationale: string | null;
  status: "candidate" | "live" | "paused" | "retired";
  metricsSnapshot: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  /** Present when fetched via list endpoint — live-execution rollup. */
  summary?: StrategySummary | null;
};

export type StrategyExecution = {
  executionId: string;
  matchedAt: string;
  stakeMultiplier: number;
  valueBet: {
    id: string;
    homeTeam: string;
    awayTeam: string;
    competition: string | null;
    marketType: string;
    atomLabel: string;
    softProvider: string;
    softOddsFirst: number;
    softOddsMax: number;
    outcome: string;
    eventStartTime: string;
    closingSharpOdds: number | null;
    sharpTrueProb: number;
    softCommissionPct: number;
    softOddsLast: number;
  } | null;
};

export const listExecutionsApi = async (
  strategyId: string,
): Promise<StrategyExecution[]> => {
  const res = await fetch(
    `/api/backtest/strategies/${encodeURIComponent(strategyId)}/executions`,
    { credentials: "include" },
  );
  const data = await unwrap<{ rows: StrategyExecution[] }>(res);
  return data.rows;
};

export type NewStrategy = {
  name: string;
  description?: string | null;
  filters: ListFilters;
  stakeMultiplier?: number;
  origin?: "manual" | "ai";
  rationale?: string | null;
  status?: Strategy["status"];
  metricsSnapshot?: Record<string, unknown> | null;
};

export const listStrategiesApi = async (opts?: {
  status?: Strategy["status"];
  origin?: Strategy["origin"];
}): Promise<Strategy[]> => {
  const params = new URLSearchParams();
  if (opts?.status) params.set("status", opts.status);
  if (opts?.origin) params.set("origin", opts.origin);
  const qs = params.toString();
  const res = await fetch(`/api/backtest/strategies${qs ? `?${qs}` : ""}`, {
    credentials: "include",
  });
  const data = await unwrap<{ rows: Strategy[] }>(res);
  return data.rows;
};

export const createStrategy = async (input: NewStrategy): Promise<Strategy> => {
  const res = await fetch(`/api/backtest/strategies`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await unwrap<{ row: Strategy }>(res);
  return data.row;
};

export const deleteStrategyApi = async (id: string): Promise<void> => {
  const res = await fetch(
    `/api/backtest/strategies/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      credentials: "include",
    },
  );
  await unwrap(res);
};

export const updateStrategyApi = async (
  id: string,
  patch: Partial<NewStrategy>,
): Promise<Strategy> => {
  const res = await fetch(
    `/api/backtest/strategies/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  const data = await unwrap<{ row: Strategy }>(res);
  return data.row;
};

// ─────────────────────────────────────────────────────────────────
// Settlement scheduler control + activity monitor
// ─────────────────────────────────────────────────────────────────

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
  abortedReason: string | null;
  error: string | null;
  estimatedCostUsd: number;
};

export type SettlementStatus = {
  active: boolean;
  paused: boolean;
  disabled: boolean;
  disabledReason: string | null;
  disabledAt: string | null;
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
  } | null;
  /**
   * Bets eligible for the next tick — mirrors the "Ready to settle" tab.
   * Lets the monitor show a single-number queue depth without a separate
   * round-trip.
   */
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
  | "resume"
  | "disable"
  | "enable";

export const getSettlementStatus = async (opts?: {
  runs?: number;
  log?: number;
}): Promise<SettlementStatus> => {
  const params = new URLSearchParams();
  if (opts?.runs !== undefined) params.set("runs", String(opts.runs));
  if (opts?.log !== undefined) params.set("log", String(opts.log));
  const qs = params.toString();
  const res = await fetch(`/api/backtest/auto-settle${qs ? `?${qs}` : ""}`, {
    credentials: "include",
  });
  return unwrap<SettlementStatus>(res);
};

export const postSettlementAction = async (
  action: SettlementAction,
  opts?: { intervalMs?: number; reason?: string },
): Promise<unknown> => {
  const res = await fetch(`/api/backtest/auto-settle`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...(opts ?? {}) }),
  });
  return unwrap(res);
};
