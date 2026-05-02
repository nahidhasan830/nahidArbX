"use client";

/**
 * AiActivityHistory — main component for the /logs/ai-activity page.
 *
 * Displays ALL AI operations from the `ai_activity_log` table —
 * settlement, grounding, entity matching, analysis, and proposals.
 * Enables diagnosing AI spend, latency, and failure patterns.
 */

import { useMemo, useCallback } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Card } from "@/components/ui/card";
import {
  useInfiniteQuery,
  useQuery,
  keepPreviousData,
} from "@tanstack/react-query";
import { resolvePreset, type DatePresetKey } from "@/lib/bets-history/date-presets";
import { useAiActivityPrefs } from "@/lib/ai-activity-log/use-ai-activity-prefs";
import { AiActivityToolbar, type AiActivityFilters } from "./AiActivityToolbar";
import { AiActivityLogTable } from "./AiActivityTable";
import type { AiActivityLogRow } from "@/lib/db/schema";
import type { AiActivityLogStats } from "@/lib/db/repositories/ai-activity-log";

// ── Constants ──

const PAGE_SIZE = 100;
const REFRESH_INTERVAL_MS = 15_000;

// ── API client ──

async function fetchLog(
  filters: AiActivityFilters & { limit: number; offset: number },
): Promise<{ rows: AiActivityLogRow[]; total: number }> {
  const params = new URLSearchParams();
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.systems?.length) params.set("systems", filters.systems.join(","));
  if (filters.statuses?.length) params.set("statuses", filters.statuses.join(","));
  if (filters.triggers?.length) params.set("triggers", filters.triggers.join(","));
  if (filters.search) params.set("search", filters.search);
  params.set("limit", String(filters.limit));
  params.set("offset", String(filters.offset));
  const res = await fetch(`/api/ai-activity-log?${params.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchLogStats(filters: AiActivityFilters): Promise<AiActivityLogStats> {
  const params = new URLSearchParams();
  params.set("aggregate", "true");
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.systems?.length) params.set("systems", filters.systems.join(","));
  if (filters.statuses?.length) params.set("statuses", filters.statuses.join(","));
  if (filters.triggers?.length) params.set("triggers", filters.triggers.join(","));
  if (filters.search) params.set("search", filters.search);
  const res = await fetch(`/api/ai-activity-log?${params.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Component ──

export function AiActivityHistory() {
  const {
    filters: rawFilters,
    setFilters,
    datePreset,
    setDatePreset,
  } = useAiActivityPrefs();

  // Build effective filters with resolved date preset
  const effectiveFilters = useMemo<AiActivityFilters>(() => {
    const base: AiActivityFilters = { ...rawFilters };
    if (datePreset !== "all" && datePreset !== "custom") {
      const { from, to } = resolvePreset(datePreset);
      base.from = from;
      base.to = to;
    }
    return base;
  }, [rawFilters, datePreset]);

  // ── Data fetching — infinite scroll ──
  const logQuery = useInfiniteQuery({
    queryKey: ["ai-activity-log", "infinite", effectiveFilters, PAGE_SIZE],
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
    queryKey: ["ai-activity-log-stats", effectiveFilters],
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
    (f: AiActivityFilters) => {
      setFilters({
        systems: f.systems,
        statuses: f.statuses,
        triggers: f.triggers,
        search: f.search,
      });
    },
    [setFilters],
  );

  const handleDatePresetChange = useCallback(
    (preset: DatePresetKey) => {
      setDatePreset(preset);
    },
    [setDatePreset],
  );

  // Build filters from rawFilters
  const toolbarFilters: AiActivityFilters = {
    from: rawFilters.from,
    to: rawFilters.to,
    systems: rawFilters.systems,
    statuses: rawFilters.statuses,
    triggers: rawFilters.triggers,
    search: rawFilters.search,
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col gap-0 w-full flex-1 min-h-0">
        <Card className="flex flex-col flex-1 min-h-0 relative overflow-hidden py-0 gap-0">
          {/* ── Toolbar ── */}
          <AiActivityToolbar
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

          <AiActivityLogTable
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
