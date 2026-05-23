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
  aiProposeRules,
  betsHistoryRule,
  bulkMarkOutcomes,
  deleteBet,
  fetchBetsStats,
  listValueBets,
  markOutcome,
  settleBets,
  type BulkUpdate,
  type ListFilters,
  type ModelTier,
  type Outcome,
  type ProposeHeadlineInput,
  type ProposeRuleFilters,
  type ProposeSliceInput,
} from "./api-client";

const DEFAULT_PAGE_SIZE = 100;
export const REFRESH_INTERVAL_MS = 30_000;

export const betsQueryKey = (filters: ListFilters, pageSize: number) =>
  ["bets-history", "value-bets", "infinite", filters, pageSize] as const;

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

/**
 * Aggregate counts + ROI for the currently-applied filter set. Runs server-side
 * so the numbers reflect the entire matched population, not just loaded pages.
 * Same refetch cadence as the list so both stay in sync.
 *
 * `preMatchOnly: true` mirrors what `useBetsList` sends so the ROI denominator
 * always matches the table's total — without it, in-play detections leak into
 * the stats roll-up while the table itself hides them.
 */
export const useBetsStats = (filters: ListFilters) => {
  const effective: ListFilters = { ...filters, preMatchOnly: true };
  return useQuery({
    queryKey: ["bets-history", "stats", effective] as const,
    queryFn: () => fetchBetsStats(effective),
    staleTime: REFRESH_INTERVAL_MS,
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
};

export const useMarkOutcome = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, outcome }: { id: string; outcome: Outcome }) =>
      markOutcome(id, outcome),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bets-history", "value-bets"] });
    },
  });
};

export const useDeleteBet = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteBet(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bets-history", "value-bets"] });
      qc.invalidateQueries({ queryKey: ["bets-history", "stats"] });
    },
  });
};

export const useBulkMarkOutcomes = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (updates: BulkUpdate[]) => bulkMarkOutcomes(updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bets-history", "value-bets"] });
    },
  });
};

export const useSettleBets = () =>
  useMutation({
    mutationFn: ({ ids }: { ids: string[] }) => settleBets(ids),
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

export const useBetsHistoryRule = () =>
  useMutation({
    mutationFn: (payload: {
      filters: ProposeRuleFilters;
      oosFraction?: number;
    }) => betsHistoryRule(payload),
  });
