/**
 * Shared types for the AlphaSearch optimizer feature.
 *
 * Mirrors the Python sidecar's `search_space.py` and the columns in
 * `optimization_runs` / `optimization_trials`. Keep these in sync — the
 * Python side is the canonical source for the search-space shape.
 */

export type OptimizationRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type SearchAlgorithm =
  | "random"
  | "tpe"
  | "nsga2"
  | "ensemble"
  | "ml-xgboost";

export type DimensionKind =
  | "continuous"
  | "discrete"
  | "categorical"
  | "boolean"
  | "subset";

export interface SearchDimension {
  name: string;
  kind: DimensionKind;
  low?: number;
  high?: number;
  step?: number;
  values?: Array<string | number | boolean>;
  min_select?: number;
}

export interface SearchSpaceJson {
  dimensions: SearchDimension[];
}

export interface CvStrategyJson {
  type: "cpcv" | "walkforward";
  n_groups: number;
  n_test_groups: number;
  embargo_pct: number;
}

/**
 * Pre-search data-scope filter. Narrows which historical bets enter the
 * analysis BEFORE the optimizer starts. Different from `SearchSpaceJson`
 * which tunes parameters within the included set.
 *
 * Empty object = include every settled bet (the default).
 *
 * If both include* and exclude* are set for the same field, include* wins
 * (whitelist semantics).
 */
export interface DataFiltersJson {
  excludeSoftProviders?: string[];
  includeSoftProviders?: string[];
  excludeMarketTypes?: string[];
  includeMarketTypes?: string[];
  /** ISO 8601 — events on/after this date. */
  eventStartFrom?: string;
  /** ISO 8601 — events strictly before this date. */
  eventStartTo?: string;
  /** When true, only include bets that were actually placed. */
  placedOnly?: boolean;
}

export interface RunSummaryJson {
  n_trials_completed: number;
  n_pareto: number;
  best_composite_score: number;
  best_trial_id: string | null;
  cpcv: { n_groups: number; n_test_groups: number; n_paths: number };
  completed_at_utc: string;
}

export interface FoldMetricJson {
  path_index: number;
  n_bets: number;
  roi_pct: number;
  win_rate_pct: number;
  sharpe: number;
  sortino: number;
  max_drawdown: number;
  total_stake: number;
  total_pnl: number;
  mean_clv_pct: number | null;
}

export interface CreateRunRequest {
  name: string;
  searchAlgorithm: SearchAlgorithm;
  nTrialsTarget: number;
  rngSeed?: number;
  cvStrategy?: Partial<CvStrategyJson>;
  searchSpace?: SearchSpaceJson;
  /** Default = {} = use every settled bet. */
  dataFilters?: DataFiltersJson;
  createdBy?: string;
  /** Default = true. When true, a Telegram ping fires on terminal status. */
  notifyOnComplete?: boolean;
}
