"use client";

/**
 * AutoPlacerHistory — main component for the /logs/auto-placer page.
 *
 * Displays ALL auto-placer decisions from the `auto_placer_log` table —
 * not just successful placements but every attempt, skip, rejection,
 * and error. This enables diagnosing strategy middleware compliance,
 * balance issues, and provider problems.
 */

import { useMemo, useCallback } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Card } from "@/components/ui/card";
import {
  useInfiniteQuery,
  useQuery,
  keepPreviousData,
} from "@tanstack/react-query";
import {
  resolvePreset,
  type DatePresetKey,
} from "@/lib/bets-history/date-presets";
import { useAutoPlacerPrefs } from "@/lib/auto-placer-history/use-auto-placer-prefs";
import { AutoPlacerToolbar, type LogFilters } from "./AutoPlacerToolbar";
import { AutoPlacerLogTable } from "./AutoPlacerTable";
import type { AutoPlacerLogRow } from "@/lib/db/schema";
import type { AutoPlacerLogStats } from "@/lib/db/repositories/auto-placer-log";

// ── Constants ──

const PAGE_SIZE = 100;
const REFRESH_INTERVAL_MS = 15_000;

// ── API client ──

async function fetchLog(
  filters: LogFilters & { limit: number; offset: number },
): Promise<{ rows: AutoPlacerLogRow[]; total: number }> {
  const params = new URLSearchParams();
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.statuses?.length)
    params.set("statuses", filters.statuses.join(","));
  if (filters.gates?.length) params.set("gates", filters.gates.join(","));
  if (filters.softProviders?.length)
    params.set("softProviders", filters.softProviders.join(","));
  if (filters.search) params.set("search", filters.search);
  params.set("limit", String(filters.limit));
  params.set("offset", String(filters.offset));
  const res = await fetch(`/api/auto-placer-log?${params.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchLogStats(filters: LogFilters): Promise<AutoPlacerLogStats> {
  const params = new URLSearchParams();
  params.set("aggregate", "true");
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.statuses?.length)
    params.set("statuses", filters.statuses.join(","));
  if (filters.gates?.length) params.set("gates", filters.gates.join(","));
  if (filters.softProviders?.length)
    params.set("softProviders", filters.softProviders.join(","));
  if (filters.search) params.set("search", filters.search);
  const res = await fetch(`/api/auto-placer-log?${params.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Component ──

export function AutoPlacerHistory() {
  const {
    filters: rawFilters,
    setFilters,
    placedPreset: datePreset,
    setPlacedPreset: setDatePreset,
  } = useAutoPlacerPrefs();

  // Build effective filters with resolved date preset (no pagination keys)
  const effectiveFilters = useMemo<LogFilters>(() => {
    const base: LogFilters = { ...rawFilters };

    if (datePreset !== "all" && datePreset !== "custom") {
      const { from, to } = resolvePreset(datePreset);
      base.from = from;
      base.to = to;
    }

    return base;
  }, [rawFilters, datePreset]);

  // ── Data fetching — infinite scroll ──
  const logQuery = useInfiniteQuery({
    queryKey: ["auto-placer-log", "infinite", effectiveFilters, PAGE_SIZE],
    queryFn: ({ pageParam }) =>
      fetchLog({
        ...effectiveFilters,
        limit: PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (last, _allPages, lastPageParam) => {
      const next = (lastPageParam as number) + PAGE_SIZE;
      return next < last.total ? next : undefined;
    },
    placeholderData: keepPreviousData,
    staleTime: REFRESH_INTERVAL_MS,
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  const statsQuery = useQuery({
    queryKey: ["auto-placer-log-stats", effectiveFilters],
    queryFn: () => fetchLogStats(effectiveFilters),
    refetchInterval: REFRESH_INTERVAL_MS,
    staleTime: REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  // Flatten all pages into a single array
  const allRows = useMemo(
    () => logQuery.data?.pages.flatMap((p) => p.rows) ?? [],
    [logQuery.data],
  );
  const totalCount = logQuery.data?.pages[0]?.total ?? 0;
  const filteredCount = allRows.length;

  // ── Filter handlers ──
  const handleFiltersChange = useCallback(
    (f: LogFilters) => {
      // Map LogFilters back to the prefs format
      setFilters({
        softProviders: f.softProviders,
        search: f.search,
        // Store statuses and gates in the filter state
        // They'll be passed through as-is since ListFilters allows extra keys
        ...({ statuses: f.statuses, gates: f.gates } as Record<
          string,
          unknown
        >),
      });
    },
    [setFilters],
  );

  const handleDatePresetChange = useCallback(
    (preset: DatePresetKey) => {
      setDatePreset(preset);
      if (preset === "all") {
        setFilters((prev) => ({ ...prev, from: undefined, to: undefined }));
      }
    },
    [setDatePreset, setFilters],
  );

  // Build LogFilters from rawFilters (which may have extra keys)
  const toolbarFilters: LogFilters = {
    from: rawFilters.from,
    to: rawFilters.to,
    softProviders: rawFilters.softProviders,
    search: rawFilters.search,
    statuses: (rawFilters as Record<string, unknown>).statuses as
      | string[]
      | undefined,
    gates: (rawFilters as Record<string, unknown>).gates as
      | string[]
      | undefined,
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col gap-0 w-full flex-1 min-h-0">
        <Card className="flex flex-col flex-1 min-h-0 relative overflow-hidden py-0 gap-0">
          {/* ── Toolbar ── */}
          <AutoPlacerToolbar
            filters={toolbarFilters}
            onFiltersChange={handleFiltersChange}
            datePreset={datePreset}
            onDatePresetChange={handleDatePresetChange}
            totalCount={totalCount}
            filteredCount={filteredCount}
            stats={statsQuery.data ?? null}
            statsLoading={statsQuery.isLoading}
            loading={logQuery.isLoading}
          />

          <AutoPlacerLogTable
            rows={allRows}
            loading={logQuery.isLoading}
            hasNextPage={logQuery.hasNextPage}
            isFetchingNextPage={logQuery.isFetchingNextPage}
            onLoadMore={() => logQuery.fetchNextPage()}
            renderFooter={() => (
              <div className="flex items-center justify-center gap-2 py-2 text-[11px] text-muted-foreground">
                {filteredCount > 0 ? (
                  <span>
                    Showing {filteredCount} of {totalCount} log entries
                  </span>
                ) : null}
              </div>
            )}
          />
        </Card>
      </div>
    </TooltipProvider>
  );
}
