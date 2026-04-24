"use client";

import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { ValueBetEvent } from "@/lib/formatting/spreadsheet";

// ============================================
// Types
// ============================================

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
  "ninewickets-exchange"?: {
    status: string;
    lastFetch: string | null;
    error: string | null;
  };
  "ninewickets-sportsbook"?: {
    status: string;
    lastFetch: string | null;
    error: string | null;
  };
  scores?: {
    pinnacleWs: { connected: boolean };
    bcPoller: { active: boolean; eventCount: number };
  };
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

// Value bet filter params for server-side filtering
export interface ValueFilterParams {
  showOnlyValue: boolean;
  evRangeMin?: number;
  evRangeMax?: number;
  softOddsMin?: number;
  softOddsMax?: number;
  softProviders?: string[]; // Array of provider IDs (empty = all)
}

// Display filter params for server-side filtering
export interface DisplayFilterParams {
  providers?: string[]; // Which providers' odds to include (empty = all)
  timeFilter?: "all" | "live" | "upcoming";
  marketTypes?: string[]; // Which market types to include (empty = all)
  minProviderCount?: number; // Min providers per atom (default 1)
}

// ============================================
// ETag Cache (per-URL, client-side)
// ============================================

// Stores last ETag + data per URL for 304 handling
const etagCache = new Map<
  string,
  { etag: string; data: DashboardApiResponse }
>();

// ============================================
// Fetch Function (with ETag/304 support)
// ============================================

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

  // Value filters (only sent when showOnlyValue is true)
  if (valueFilters?.showOnlyValue) {
    params.set("showOnlyValue", "true");
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

  // Display filters (provider exclusion, time, market types)
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

  // Send ETag for conditional request (server returns 304 if unchanged)
  const cached = etagCache.get(url);
  if (cached) {
    headers["If-None-Match"] = cached.etag;
  }

  const res = await fetch(url, { signal, headers });

  // 304 Not Modified — return cached data (zero bandwidth)
  if (res.status === 304 && cached) {
    return cached.data;
  }

  if (!res.ok) {
    throw new Error("Failed to fetch events");
  }

  const data: DashboardApiResponse = await res.json();

  // Store ETag for next request
  const etag = res.headers.get("etag");
  if (etag) {
    etagCache.set(url, { etag, data });
  }

  return data;
}

// ============================================
// Hook
// ============================================

interface UseInfiniteEventsOptions {
  /** When true, infinite query is disabled */
  enabled?: boolean;
  /** Search term to filter events server-side */
  search?: string;
  /** Number of events per page */
  pageSize?: number;
  /** Value bet filters for server-side filtering */
  valueFilters?: ValueFilterParams;
  /** Display filters for server-side filtering (providers, time, market types) */
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

  // Include all filters in query key so data refetches when any filter changes
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
    // Keep data fresh for 30 seconds
    staleTime: 30 * 1000,
    // Garbage collect after 5 minutes
    gcTime: 5 * 60 * 1000,
    // Always refetch when the query becomes enabled (e.g., switching from arbs-only)
    refetchOnMount: "always",
  });

  // Flatten all pages into a single events array
  const allEvents: ValueBetEvent[] =
    query.data?.pages.flatMap((page) => page.events) ?? [];

  // Get metadata from the first page (summary, syncStatus, etc.)
  const firstPage = query.data?.pages[0];

  // Get pagination info from the last page
  const lastPage = query.data?.pages[query.data.pages.length - 1];
  const totalCount = lastPage?.pagination?.totalCount ?? 0;

  // Prefetch next page when we're close to the end
  const prefetchNextPage = () => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      query.fetchNextPage();
    }
  };

  // Invalidate all event queries (useful after sync)
  const invalidateEvents = () => {
    queryClient.invalidateQueries({ queryKey: ["events"] });
  };

  return {
    // Query state
    events: allEvents,
    isLoading: query.isLoading,
    isFetching: query.isFetching, // True when any fetch is in progress (including refetch)
    isError: query.isError,
    error: query.error,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: query.hasNextPage ?? false,

    // Metadata from first page
    syncStatus: firstPage?.syncStatus ?? null,
    connectionHealth: firstPage?.connectionHealth ?? null,
    summary: firstPage?.summary ?? null,

    // Pagination info
    totalCount,
    loadedCount: allEvents.length,

    // Actions
    fetchNextPage: query.fetchNextPage,
    prefetchNextPage,
    refetch: query.refetch,
    invalidateEvents,
  };
}
