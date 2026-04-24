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

export type SearchAlgorithm = "random" | "tpe" | "nsga2" | "ensemble";

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
  createdBy?: string;
}
