"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import {
  aiAnalyzeBets,
  aiLabelBets,
  aiProposeRules,
  backtestRule,
  bulkMarkOutcomes,
  createStrategy,
  deleteStrategyApi,
  listExecutionsApi,
  listStrategiesApi,
  listValueBets,
  markOutcome,
  updateStrategyApi,
  type BulkUpdate,
  type ListFilters,
  type ModelTier,
  type NewStrategy,
  type Outcome,
  type ProposeHeadlineInput,
  type ProposeRuleFilters,
  type ProposeSliceInput,
  type Strategy,
} from "./api-client";

const DEFAULT_PAGE_SIZE = 100;
const REFRESH_INTERVAL_MS = 30_000;

export const betsQueryKey = (filters: ListFilters, pageSize: number) =>
  ["backtest", "value-bets", "infinite", filters, pageSize] as const;

export const useBetsList = (
  filters: ListFilters,
  pageSize: number = DEFAULT_PAGE_SIZE,
) =>
  useInfiniteQuery({
    queryKey: betsQueryKey(filters, pageSize),
    queryFn: ({ pageParam }) =>
      listValueBets({
        ...filters,
        preMatchOnly: true,
        limit: pageSize,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) => {
      const next = last.offset + last.limit;
      return next < last.total ? next : undefined;
    },
    placeholderData: keepPreviousData,
    staleTime: REFRESH_INTERVAL_MS,
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

export const useMarkOutcome = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, outcome }: { id: string; outcome: Outcome }) =>
      markOutcome(id, outcome),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["backtest", "value-bets"] });
    },
  });
};

export const useBulkMarkOutcomes = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (updates: BulkUpdate[]) => bulkMarkOutcomes(updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["backtest", "value-bets"] });
    },
  });
};

export const useAiLabel = () =>
  useMutation({
    mutationFn: ({ ids }: { ids: string[] }) => aiLabelBets(ids),
  });

export const useAiAnalyze = () =>
  useMutation({
    mutationFn: (payload: {
      ids?: string[];
      filters?: ListFilters;
      model?: ModelTier;
    }) => aiAnalyzeBets(payload),
  });

export const useProposeRules = () =>
  useMutation({
    mutationFn: (payload: {
      topSlices: ProposeSliceInput[];
      headline: ProposeHeadlineInput;
      maxRules?: number;
    }) => aiProposeRules(payload),
  });

export const useBacktestRule = () =>
  useMutation({
    mutationFn: (payload: {
      filters: ProposeRuleFilters;
      oosFraction?: number;
    }) => backtestRule(payload),
  });

// ─────────────────────────────────────────────────────────────────
// Strategies
// ─────────────────────────────────────────────────────────────────

const STRATEGIES_KEY = ["backtest", "strategies"] as const;

export const useStrategies = (opts?: {
  status?: Strategy["status"];
  origin?: Strategy["origin"];
}) =>
  useQuery({
    queryKey: [...STRATEGIES_KEY, opts ?? {}],
    queryFn: () => listStrategiesApi(opts),
    staleTime: 15_000,
  });

export const useCreateStrategy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: NewStrategy) => createStrategy(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: STRATEGIES_KEY }),
  });
};

export const useUpdateStrategy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<NewStrategy> }) =>
      updateStrategyApi(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: STRATEGIES_KEY }),
  });
};

export const useDeleteStrategy = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteStrategyApi(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: STRATEGIES_KEY }),
  });
};

export const useStrategyExecutions = (strategyId: string | null) =>
  useQuery({
    queryKey: ["backtest", "strategies", strategyId, "executions"] as const,
    queryFn: () =>
      strategyId ? listExecutionsApi(strategyId) : Promise.resolve([]),
    enabled: !!strategyId,
    staleTime: 15_000,
  });
