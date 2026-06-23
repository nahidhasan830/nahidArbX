"use client";

import {
  useInfiniteQuery,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import type { ValueBetEvent } from "@/lib/formatting/spreadsheet";


interface PaginationMeta {
  page: number;
  pageSize: number;
  hasMore: boolean;
  totalCount: number;
  search?: string;
}

interface PhaseProgress {
  current: number;
  total: number;
  subPhase?: string;
}

interface SyncStatus {
  isSyncing: boolean;
  isSchedulerActive: boolean;
  currentPhase: string | null;
  phaseProgress: PhaseProgress | null;
  lastSyncStart: string | null;
  lastSyncEnd: string | null;
}

interface ConnectionHealth {
  betconstruct: {
    connected: boolean;
    consecutiveTimeouts: number;
    isReconnecting: boolean;
    pendingRequests: number;
  };
  pinnacle?: {
    hasToken: boolean;
    tokenTTL: number | null;
    expiresIn: string | null;
  };
  scores?: {
    pinnacleWs: { connected: boolean };
    bcPoller: { active: boolean; eventCount: number };
  };
  [providerId: string]: unknown;
}

export interface DashboardApiResponse {
  events: ValueBetEvent[];
  syncStatus: SyncStatus;
  connectionHealth?: ConnectionHealth;
  summary: {
    totalEvents: number;
    matchedEvents: number;
    eventsWithOdds: number;
    eventsWithValue?: number;
    totalValueBets: number;
    bestEvPct: number | null;
  };
  providerCounts?: Record<string, number>;
  stats?: Record<string, unknown>;
  pagination?: PaginationMeta;
}

export interface ValueFilterParams {
  showOnlyValue: boolean;
  evRangeMin?: number;
  evRangeMax?: number;
  softOddsMin?: number;
  softOddsMax?: number;
  softProviders?: string[];
}

export interface DisplayFilterParams {
  providers?: string[];
  timeFilter?: "all" | "live" | "upcoming";
  marketTypes?: string[];
  minProviderCount?: number;
}


const etagCache = new Map<
  string,
  { etag: string; data: DashboardApiResponse }
>();


async function fetchEvents(
  page: number,
  pageSize: number,
  search: string,
  valueFilters?: ValueFilterParams,
  displayFilters?: DisplayFilterParams,
  signal?: AbortSignal,
): Promise<DashboardApiResponse> {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });

  if (search) {
    params.set("search", search);
  }

  if (valueFilters) {
    if (valueFilters.showOnlyValue) {
      params.set("showOnlyValue", "true");
    }
    if (valueFilters.evRangeMin !== undefined) {
      params.set("evMin", String(valueFilters.evRangeMin));
    }
    if (valueFilters.evRangeMax !== undefined) {
      params.set("evMax", String(valueFilters.evRangeMax));
    }
    if (valueFilters.softOddsMin !== undefined) {
      params.set("oddsMin", String(valueFilters.softOddsMin));
    }
    if (valueFilters.softOddsMax !== undefined) {
      params.set("oddsMax", String(valueFilters.softOddsMax));
    }
    if (valueFilters.softProviders && valueFilters.softProviders.length > 0) {
      params.set("softProviders", valueFilters.softProviders.join(","));
    }
  }

  if (displayFilters?.providers && displayFilters.providers.length > 0) {
    params.set("providers", displayFilters.providers.join(","));
  }
  if (displayFilters?.timeFilter && displayFilters.timeFilter !== "all") {
    params.set("timeFilter", displayFilters.timeFilter);
  }
  if (displayFilters?.marketTypes && displayFilters.marketTypes.length > 0) {
    params.set("marketTypes", displayFilters.marketTypes.join(","));
  }
  if (displayFilters?.minProviderCount && displayFilters.minProviderCount > 1) {
    params.set("minProviderCount", String(displayFilters.minProviderCount));
  }

  const url = `/api/value-bets?${params}`;
  const headers: HeadersInit = {};

  const cached = etagCache.get(url);
  if (cached) {
    headers["If-None-Match"] = cached.etag;
  }

  const res = await fetch(url, { signal, headers });

  if (res.status === 304 && cached) {
    return cached.data;
  }

  if (!res.ok) {
    throw new Error("Failed to fetch events");
  }

  const data: DashboardApiResponse = await res.json();

  const etag = res.headers.get("etag");
  if (etag) {
    etagCache.set(url, { etag, data });
  }

  return data;
}


interface UseInfiniteEventsOptions {
  enabled?: boolean;
  search?: string;
  pageSize?: number;
  valueFilters?: ValueFilterParams;
  displayFilters?: DisplayFilterParams;
}

export function useInfiniteEvents(options: UseInfiniteEventsOptions = {}) {
  const {
    enabled = true,
    search = "",
    pageSize = 50,
    valueFilters,
    displayFilters,
  } = options;
  const queryClient = useQueryClient();

  const query = useInfiniteQuery({
    queryKey: [
      "events",
      "infinite",
      search,
      pageSize,
      valueFilters,
      displayFilters,
    ],
    queryFn: ({ pageParam, signal }) =>
      fetchEvents(
        pageParam,
        pageSize,
        search,
        valueFilters,
        displayFilters,
        signal,
      ),
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore
        ? (lastPage.pagination.page ?? 0) + 1
        : undefined,
    initialPageParam: 0,
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnMount: "always",
  });

  const allEvents: ValueBetEvent[] =
    query.data?.pages.flatMap((page) => page.events) ?? [];

  const firstPage = query.data?.pages[0];

  const lastPage = query.data?.pages[query.data.pages.length - 1];
  const totalCount = lastPage?.pagination?.totalCount ?? 0;

  const prefetchNextPage = () => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      query.fetchNextPage();
    }
  };

  const invalidateEvents = () => {
    queryClient.invalidateQueries({ queryKey: ["events"] });
  };

  return {
    events: allEvents,
    isLoading: query.isLoading,
    isFetching: query.isFetching, // True when any fetch is in progress (including refetch)
    isError: query.isError,
    error: query.error,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: query.hasNextPage ?? false,

    syncStatus: firstPage?.syncStatus ?? null,
    connectionHealth: firstPage?.connectionHealth ?? null,
    summary: firstPage?.summary ?? null,

    totalCount,
    loadedCount: allEvents.length,

    fetchNextPage: query.fetchNextPage,
    prefetchNextPage,
    refetch: query.refetch,
    invalidateEvents,
  };
}
