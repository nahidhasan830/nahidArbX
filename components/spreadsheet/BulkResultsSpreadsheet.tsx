"use client";

import {
  useMemo,
  useCallback,
  useState,
  useEffect,
  useDeferredValue,
  useRef,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  PROVIDER_IDS,
  getProviderShortName,
  getSoftProviders,
  type ProviderKey,
} from "@/lib/providers/registry";
import {
  transformToSpreadsheetRows,
  getUniqueMarketTypes,
  type BulkEventResult,
  type SpreadsheetRow,
} from "@/lib/formatting/spreadsheet";
import { useBulkAnalysisPreferences } from "@/components/hooks/useBulkAnalysisPreferences";
import { useProviderRuntimeState } from "@/components/hooks/useProviderRuntimeState";
import {
  SpreadsheetToolbar,
  getProviderBadgeClasses,
} from "./SpreadsheetToolbar";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Loader2, RefreshCw, X, Eye, Copy } from "lucide-react";
import { toast } from "sonner";
import { Feature } from "@/components/auth/AuthProvider";
import {
  ValueBetDetailsModal,
  type LiveMatchInfo,
  type ValueBetDetails,
} from "./ValueBetDetailsModal";
import { CONFIGURED_BETTING_PROVIDER_IDS } from "@/lib/betting/configured-ids";

// ============================================
// Helpers
// ============================================

function formatEventTime(startTime: string): string {
  const date = new Date(startTime);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const isTomorrow =
    date.toDateString() === new Date(now.getTime() + 86400000).toDateString();

  const timeStr = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (date <= now) {
    // Already started - show how long ago
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) return `Started ${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    return `Started ${diffHours}h ${diffMins % 60}m ago`;
  }

  if (isToday) return `Today ${timeStr}`;
  if (isTomorrow) return `Tomorrow ${timeStr}`;

  const dateStr = date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
  return `${dateStr} ${timeStr}`;
}

// Count how many soft providers have value opportunities for this atom
function countValueProviders(
  odds: Partial<
    Record<
      ProviderKey,
      { value: number; timestamp: number; suspended?: boolean }
    >
  >,
  trueProb: number | null,
): number {
  if (!trueProb || trueProb <= 0) return 0;

  const softProviders = getSoftProviders();
  let count = 0;

  for (const provider of softProviders) {
    const oddsData = odds[provider];
    if (!oddsData || oddsData.suspended) continue;

    // EV = odds * trueProb - 1; positive = value
    const ev = oddsData.value * trueProb - 1;
    if (ev > 0) count++;
  }

  return count;
}

// ============================================
// Types
// ============================================

interface BulkResultsSpreadsheetProps {
  events: BulkEventResult[];
  isLoading?: boolean;
  isSyncing?: boolean; // Background sync in progress
  onRefreshComplete?: () => void;
  // Infinite scroll props
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  totalCount?: number;
  // Controlled search (for server-side search)
  searchTerm?: string;
  onSearchChange?: (value: string) => void;
}

// ============================================
// Odds Cell Component
// ============================================

interface OddsCellProps {
  odds:
    | { value: number; timestamp: number; isBest: boolean; suspended?: boolean }
    | null
    | undefined;
  now: number;
  onClick?: () => void;
}

function OddsCell({ odds, now, onClick }: OddsCellProps) {
  if (!odds) {
    return (
      <td className="text-center px-2 py-1.5 text-muted-foreground/40 font-mono text-xs">
        -
      </td>
    );
  }

  const isBest = odds.isBest;
  const isSuspended = odds.suspended;
  const clickable = Boolean(onClick) && !isSuspended;

  // Calculate age for freshness indicator
  const ageMs = now - odds.timestamp;
  const ageMinutes = ageMs / 60000;
  const ageColor =
    ageMinutes < 1
      ? "bg-green-500"
      : ageMinutes < 5
        ? "bg-yellow-500"
        : "bg-red-500";

  return (
    <td
      onClick={clickable ? onClick : undefined}
      title={clickable ? "Click to place a bet at this price" : undefined}
      className={`text-center px-2 py-1.5 font-mono text-xs relative ${
        isSuspended
          ? "text-muted-foreground/60"
          : isBest
            ? "font-bold text-green-400 bg-green-900/10"
            : "text-foreground"
      } ${clickable ? "cursor-pointer hover:bg-emerald-500/15 hover:ring-1 hover:ring-emerald-500/40" : ""}`}
    >
      <div className="flex flex-col items-center">
        <div className="flex items-center justify-center gap-1">
          <span className={isSuspended ? "opacity-60" : ""}>
            {odds.value.toFixed(2)}
          </span>
          {!isSuspended && isBest && (
            <span className="text-[9px] text-green-400">*</span>
          )}
        </div>
      </div>
      {/* Suspended overlay */}
      {isSuspended && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-yellow-900/40"
          title="Market suspended - not available for betting"
        >
          <span className="text-[8px] font-bold uppercase text-yellow-400 tracking-wider">
            Suspended
          </span>
        </div>
      )}
      {/* Freshness indicator dot */}
      {!isSuspended && (
        <div
          className={`absolute bottom-0.5 right-0.5 w-1.5 h-1.5 rounded-full ${ageColor}`}
          title={`${Math.round(ageMinutes)} min ago`}
        />
      )}
    </td>
  );
}

// ============================================
// Main Component
// ============================================

const DEFAULT_COLUMN_WIDTHS: Record<string, number> = {
  event: 320,
  competition: 140,
  market: 150,
  outcome: 90,
  provider: 70,
  best: 55,
  ev: 65,
  actions: 130,
};

export function BulkResultsSpreadsheet({
  events,
  isLoading = false,
  isSyncing = false,
  onRefreshComplete,
  hasNextPage = false,
  isFetchingNextPage = false,
  onLoadMore,
  totalCount,
  searchTerm: controlledSearchTerm,
  onSearchChange: controlledOnSearchChange,
}: BulkResultsSpreadsheetProps) {
  const prefs = useBulkAnalysisPreferences();
  const providerRuntime = useProviderRuntimeState();

  // State for value bet details modal
  const [selectedValueBet, setSelectedValueBet] = useState<{
    eventLabel: string;
    competition: string;
    startTime: string;
    marketLabel: string;
    outcomeLabel: string;
    atomId: string;
    // Fields below are for manual placement — the modal's PlaceBetPanel
    // needs the normalized family/atom/team ids to build a runtime
    // descriptor for POST /api/bets/place.
    familyId: string;
    marketType: string;
    details: ValueBetDetails;
    // For refresh
    eventId: string;
    providerEventIds: Record<string, string>;
    // All provider odds for this atom (for multi-provider value calc)
    atomOdds: SpreadsheetRow["odds"];
    liveScore?: LiveMatchInfo;
  } | null>(null);

  // Use controlled search if provided, otherwise fall back to internal prefs
  const searchTerm = controlledSearchTerm ?? prefs.searchTerm;
  const onSearchChange = controlledOnSearchChange ?? prefs.setSearchTerm;

  // Ref for virtualization scroll container
  const tableContainerRef = useRef<HTMLDivElement>(null);

  const runtimeEnabledProviders = useMemo(
    () => new Set(PROVIDER_IDS.filter((id) => providerRuntime.isEnabled(id))),
    [providerRuntime],
  );

  const effectiveSelectedProviders = useMemo(
    () =>
      new Set(
        Array.from(prefs.selectedProviders).filter((id) =>
          runtimeEnabledProviders.has(id),
        ),
      ),
    [prefs.selectedProviders, runtimeEnabledProviders],
  );

  // Defer filter values - UI updates immediately, expensive computation follows
  // This prevents dropdown/checkbox interactions from feeling laggy
  // NOTE: showOnlyValue is NOT deferred because it fundamentally changes
  // which data is fetched/shown (switching between query modes)
  const deferredFilters = useDeferredValue({
    selectedProviders: effectiveSelectedProviders,
    minProviderCount: prefs.minProviderCount,
    searchTerm, // Use controlled searchTerm
    selectedMarketTypes: prefs.selectedMarketTypes,
    timeFilter: prefs.timeFilter,
    suspiciousThresholdPct: prefs.suspiciousThresholdPct,
    minEvPct: prefs.minEvPct, // For value betting filter
  });

  // Combine deferred filters with immediate showOnlyValue
  const transformFilters = useMemo(
    () => ({
      ...deferredFilters,
      showOnlyValue: prefs.showOnlyValue, // For value betting mode
      sortMode: prefs.sortMode,
      filterHighEv: prefs.filterHighEv,
      maxEvPctFilter: prefs.maxEvPctFilter,
    }),
    [
      deferredFilters,
      prefs.showOnlyValue,
      prefs.sortMode,
      prefs.filterHighEv,
      prefs.maxEvPctFilter,
    ],
  );

  // Current timestamp for freshness calculation (update every 30s)
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(interval);
  }, []);

  // Track loading state per event for refresh buttons
  const [refreshingEvents, setRefreshingEvents] = useState<Set<string>>(
    new Set(),
  );

  // Track loading state per event+provider for raw data copy
  const [copyingRawData, setCopyingRawData] = useState<string | null>(null); // "eventId:provider"

  // Hidden families (temporarily dismissed) - key is "eventId|familyId"
  const [hiddenFamilies, setHiddenFamilies] = useState<Set<string>>(new Set());

  const handleHideFamily = useCallback((eventId: string, familyId: string) => {
    const key = `${eventId}|${familyId}`;
    setHiddenFamilies((prev) => new Set(prev).add(key));
  }, []);

  const handleRestoreAllHidden = useCallback(() => {
    setHiddenFamilies(new Set());
  }, []);

  // Column widths (resizable)
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(
    DEFAULT_COLUMN_WIDTHS,
  );

  // TanStack Table pattern: Generate CSS variables from column widths
  const columnSizeVars = useMemo(() => {
    const vars: Record<string, string> = {};
    for (const [col, size] of Object.entries(columnWidths)) {
      vars[`--col-${col}-size`] = `${size}`;
    }
    return vars;
  }, [columnWidths]);

  // Performant resize: Update CSS variable directly, not th.style.width
  const handleResizeStart = useCallback(
    (col: string, e: React.MouseEvent) => {
      e.preventDefault();
      // Find the container with CSS variables
      const container = (e.target as HTMLElement).closest(
        ".table-container",
      ) as HTMLElement;
      if (!container) return;

      const startX = e.clientX;
      const startWidth = columnWidths[col] ?? DEFAULT_COLUMN_WIDTHS[col] ?? 100;

      // Create overlay to capture mouse events during drag
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:9999;cursor:col-resize";
      document.body.appendChild(overlay);

      let currentWidth = startWidth;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const diff = moveEvent.clientX - startX;
        currentWidth = Math.max(50, startWidth + diff);
        // Update CSS variable on container - single DOM write, no layout thrashing
        container.style.setProperty(`--col-${col}-size`, `${currentWidth}`);
      };

      const handleMouseUp = () => {
        overlay.remove();
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        // Sync to React state (single re-render at end)
        setColumnWidths((prev) => ({ ...prev, [col]: currentWidth }));
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [columnWidths],
  );

  // Refresh single event handler with client-side timeout
  // Accepts providerEventIds to avoid "event not found" race condition during sync
  const handleRefreshEvent = useCallback(
    async (
      eventId: string,
      providerEventIds?: Record<string, string>,
      eventLabel?: string,
    ) => {
      setRefreshingEvents((prev) => new Set(prev).add(eventId));

      // Create abort controller for client-side timeout (12s - less than server's 15s)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);

      try {
        const res = await fetch("/api/value-bets/refresh-event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId, providers: providerEventIds }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          const data = await res
            .json()
            .catch(() => ({ error: "Unknown error" }));
          const teamLabel = eventLabel || "Event";
          toast.error("Couldn't refresh event", {
            description: `${teamLabel} — ${data.error || "unknown error"}`,
          });
        } else {
          const data = await res.json();
          const teamLabel = eventLabel || "Event";

          // Handle "skipped" response when sync is in progress
          if (data.skipped) {
            toast.info("Sync in progress", {
              description: `${teamLabel} will update automatically`,
            });
            return;
          }

          if (data.oddsCount > 0) {
            const breakdown = Object.entries(data.byProvider || {})
              .filter(([, count]) => (count as number) > 0)
              .map(([id, count]) => `${getProviderShortName(id)} ${count}`)
              .join(" · ");
            toast.success("Event refreshed", {
              description: `${teamLabel} — ${breakdown || `${data.oddsCount} markets`}`,
            });
            onRefreshComplete?.(); // Trigger parent re-fetch for immediate UI update
          } else {
            toast.warning("No odds available", {
              description: `${teamLabel} — no provider returned markets`,
            });
          }
        }
      } catch (err) {
        clearTimeout(timeoutId);
        const teamLabel = eventLabel || "Event";
        if (err instanceof Error && err.name === "AbortError") {
          toast.error("Refresh timed out", {
            description: `${teamLabel} — try again in a moment`,
          });
        } else {
          toast.error("Network error", {
            description: `Couldn't refresh ${teamLabel}`,
          });
        }
      } finally {
        setRefreshingEvents((prev) => {
          const next = new Set(prev);
          next.delete(eventId);
          return next;
        });
      }
    },
    [onRefreshComplete],
  );

  // Copy raw data handler - accepts optional providerEventId to avoid stale data issues
  const handleCopyRawData = useCallback(
    async (
      eventId: string,
      provider: ProviderKey,
      providerEventId?: string,
    ) => {
      const key = `${eventId}:${provider}`;
      setCopyingRawData(key);

      // Create abort controller for client-side timeout (10s)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      try {
        // Include providerEventId if available to avoid "event not found" errors
        const url = providerEventId
          ? `/api/value-bets/raw-data/${encodeURIComponent(eventId)}?provider=${provider}&providerEventId=${providerEventId}`
          : `/api/value-bets/raw-data/${encodeURIComponent(eventId)}?provider=${provider}`;

        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!res.ok) {
          const data = await res
            .json()
            .catch(() => ({ error: "Unknown error" }));
          toast.error("Couldn't fetch raw data", {
            description: data.error || "Unknown error",
          });
          return;
        }

        const data = await res.json();
        await navigator.clipboard.writeText(
          JSON.stringify(data.rawResponse, null, 2),
        );
        toast.success("Copied", {
          description: `${getProviderShortName(provider)} raw response`,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        if (err instanceof Error && err.name === "AbortError") {
          toast.error("Copy timed out", {
            description: "Request took longer than 10s",
          });
        } else {
          toast.error("Couldn't copy", {
            description: err instanceof Error ? err.message : undefined,
          });
        }
      } finally {
        setCopyingRawData(null);
      }
    },
    [],
  );

  // Build map of eventId -> provider info (names + providerEventIds + liveScore + suspended)
  const eventProvidersMap = useMemo(() => {
    const map = new Map<
      string,
      {
        providers: ProviderKey[];
        providerEventIds: Record<string, string>;
        liveScore?: LiveMatchInfo;
        suspended?: boolean;
      }
    >();
    for (const event of events) {
      map.set(event.eventId, {
        providers: event.providers as ProviderKey[],
        providerEventIds: event.providerEventIds || {},
        liveScore: event.liveScore,
        suspended: event.suspended,
      });
    }
    return map;
  }, [events]);

  // Get unique market types for filter
  const marketTypes = useMemo(() => getUniqueMarketTypes(events), [events]);

  // Visible provider columns (selected minus hidden)
  const visibleProviders = useMemo(
    () =>
      PROVIDER_IDS.filter(
        (p) =>
          runtimeEnabledProviders.has(p) &&
          prefs.selectedProviders.has(p) &&
          !prefs.hiddenColumns.has(p),
      ),
    [runtimeEnabledProviders, prefs.selectedProviders, prefs.hiddenColumns],
  );

  // Transform data to flat rows (uses deferred filters for responsive UI)
  const allRows = useMemo(
    () => transformToSpreadsheetRows(events, transformFilters),
    [events, transformFilters],
  );

  // Apply filters and exclude hidden families
  const rows = useMemo(() => {
    let filtered = allRows;

    // Exclude hidden families
    if (hiddenFamilies.size > 0) {
      filtered = filtered.filter((row) => {
        const key = `${row.eventId}|${row.familyId}`;
        return !hiddenFamilies.has(key);
      });
    }

    // Filter by suspicious only
    if (prefs.showOnlySuspicious) {
      filtered = filtered.filter((row) => row.isSuspicious);
    }

    // Recalculate isFirst/isLast flags after filtering
    // (original flags are based on pre-filter order, now invalid)
    let lastEventId: string | null = null;
    let lastFamilyKey: string | null = null;

    return filtered.map((row, index) => {
      const isFirstFamilyInEvent = row.eventId !== lastEventId;
      const familyKey = `${row.eventId}|${row.familyId}`;
      const isFirstAtomInFamily = familyKey !== lastFamilyKey;
      // Check if next row is a different event (or we're at the end)
      const isLastAtomInEvent =
        index === filtered.length - 1 ||
        filtered[index + 1]?.eventId !== row.eventId;

      lastEventId = row.eventId;
      lastFamilyKey = familyKey;

      // Only update if changed to avoid unnecessary object creation
      if (
        row.isFirstFamilyInEvent !== isFirstFamilyInEvent ||
        row.isFirstAtomInFamily !== isFirstAtomInFamily ||
        row.isLastAtomInEvent !== isLastAtomInEvent
      ) {
        return {
          ...row,
          isFirstFamilyInEvent,
          isFirstAtomInFamily,
          isLastAtomInEvent,
        };
      }
      return row;
    });
  }, [allRows, hiddenFamilies, prefs.showOnlySuspicious]);

  // Count unique value bet families
  const valueRowCount = useMemo(() => {
    const uniqueFamilies = new Set<string>();
    for (const row of rows) {
      if (row.hasValue) {
        uniqueFamilies.add(`${row.eventId}|${row.familyId}`);
      }
    }
    return uniqueFamilies.size;
  }, [rows]);

  // Count unique suspicious families (possible mapping errors)
  const suspiciousCount = useMemo(() => {
    const uniqueFamilies = new Set<string>();
    for (const row of allRows) {
      // Use allRows to show count regardless of filter
      if (row.isSuspicious) {
        uniqueFamilies.add(`${row.eventId}|${row.familyId}`);
      }
    }
    return uniqueFamilies.size;
  }, [allRows]);

  // Update modal data when rows change (e.g., after refresh)
  useEffect(() => {
    if (!selectedValueBet) return;

    // Find the matching row in the updated data
    const matchingRow = allRows.find(
      (row) =>
        row.eventId === selectedValueBet.eventId &&
        row.atomId === selectedValueBet.atomId,
    );
    const latestEventInfo = eventProvidersMap.get(selectedValueBet.eventId);
    const nextLiveScore = latestEventInfo?.liveScore;
    const nextProviderEventIds = latestEventInfo?.providerEventIds;
    const liveScoreChanged =
      JSON.stringify(nextLiveScore ?? null) !==
      JSON.stringify(selectedValueBet.liveScore ?? null);
    const providerEventIdsChanged =
      nextProviderEventIds !== undefined &&
      JSON.stringify(nextProviderEventIds) !==
        JSON.stringify(selectedValueBet.providerEventIds);

    if (matchingRow && matchingRow.valueBetDetails) {
      const nextDetails = matchingRow.valueBetDetails;
      const detailsChanged =
        nextDetails.timestamp !== selectedValueBet.details.timestamp;

      // Update modal with fresh data if it changed
      if (detailsChanged || liveScoreChanged || providerEventIdsChanged) {
        setSelectedValueBet((prev) =>
          prev
            ? {
                ...prev,
                details: detailsChanged ? nextDetails : prev.details,
                outcomeLabel: matchingRow.outcomeLabel,
                marketLabel: matchingRow.marketLabel,
                atomOdds: detailsChanged ? matchingRow.odds : prev.atomOdds,
                providerEventIds: nextProviderEventIds ?? prev.providerEventIds,
                liveScore: nextLiveScore,
              }
            : null,
        );
      }
    }
    // Note: If matchingRow is not found at all, the event may have been removed - leave modal as is
  }, [
    allRows,
    eventProvidersMap,
    selectedValueBet?.eventId,
    selectedValueBet?.atomId,
    selectedValueBet?.details.timestamp,
    selectedValueBet?.liveScore,
    selectedValueBet?.providerEventIds,
  ]);

  // Row virtualizer for performance with large datasets
  // Estimated row height: 32px (actual height varies based on content)
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => 32,
    overscan: 15, // Render 15 extra rows above/below viewport
  });

  // Infinite scroll: fetch more when near bottom
  useEffect(() => {
    const container = tableContainerRef.current;
    if (!container || !onLoadMore || !hasNextPage || isFetchingNextPage) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      // Fetch more when 80% scrolled
      if (scrollTop + clientHeight >= scrollHeight * 0.8) {
        onLoadMore();
      }
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [hasNextPage, isFetchingNextPage, onLoadMore]);

  // Auto-load more when filters result in few/no visible rows but more data exists
  // This handles the case where first page is all "live" events but user selects "upcoming"
  useEffect(() => {
    if (!onLoadMore || !hasNextPage || isFetchingNextPage) return;
    // If we have loaded events but filtered rows are very few, load more
    if (events.length > 0 && rows.length < 10) {
      onLoadMore();
    }
  }, [events.length, rows.length, hasNextPage, isFetchingNextPage, onLoadMore]);

  // Common toolbar component
  const toolbar = (
    <SpreadsheetToolbar
      hiddenColumns={prefs.hiddenColumns}
      onToggleColumnVisibility={prefs.toggleColumnVisibility}
      onShowAllColumns={prefs.showAllColumns}
      showOnlyValue={prefs.showOnlyValue}
      onToggleShowOnlyValue={() => prefs.setShowOnlyValue(!prefs.showOnlyValue)}
      valueRowCount={valueRowCount}
      minEvPct={prefs.minEvPct}
      onMinEvPctChange={prefs.setMinEvPct}
      sortMode={prefs.sortMode}
      onSortModeChange={prefs.setSortMode}
      filterHighEv={prefs.filterHighEv}
      onToggleFilterHighEv={() => prefs.setFilterHighEv(!prefs.filterHighEv)}
      maxEvPctFilter={prefs.maxEvPctFilter}
      onMaxEvPctFilterChange={prefs.setMaxEvPctFilter}
      evRangeMin={prefs.evRangeMin}
      evRangeMax={prefs.evRangeMax}
      onEvRangeChange={(min, max) => {
        prefs.setEvRangeMin(min);
        prefs.setEvRangeMax(max);
      }}
      softOddsRangeMin={prefs.softOddsRangeMin}
      softOddsRangeMax={prefs.softOddsRangeMax}
      onSoftOddsRangeChange={(min, max) => {
        prefs.setSoftOddsRangeMin(min);
        prefs.setSoftOddsRangeMax(max);
      }}
      selectedSoftProviders={prefs.selectedSoftProviders}
      onToggleSoftProvider={prefs.toggleSoftProvider}
      onSelectAllSoftProviders={prefs.selectAllSoftProviders}
      onDeselectAllSoftProviders={prefs.deselectAllSoftProviders}
      showOnlySuspicious={prefs.showOnlySuspicious}
      onToggleShowOnlySuspicious={() =>
        prefs.setShowOnlySuspicious(!prefs.showOnlySuspicious)
      }
      suspiciousCount={suspiciousCount}
      suspiciousThresholdPct={prefs.suspiciousThresholdPct}
      onSuspiciousThresholdChange={prefs.setSuspiciousThresholdPct}
      minProviderCount={prefs.minProviderCount}
      onMinProviderCountChange={prefs.setMinProviderCount}
      searchTerm={searchTerm}
      onSearchChange={onSearchChange}
      selectedMarketTypes={prefs.selectedMarketTypes}
      onToggleMarketType={prefs.toggleMarketType}
      onSelectAllMarketTypes={() => prefs.selectAllMarketTypes(marketTypes)}
      onDeselectAllMarketTypes={prefs.deselectAllMarketTypes}
      marketTypes={marketTypes}
      timeFilter={prefs.timeFilter}
      onTimeFilterChange={prefs.setTimeFilter}
      totalRows={rows.length}
      onReset={() => {
        prefs.resetFilters();
        onSearchChange("");
      }}
      hasActiveFilters={prefs.hasActiveFilters || searchTerm.length > 0}
      onSaveAsDefault={() => {
        prefs.saveCurrentAsDefault();
        toast.success("Filters saved", {
          description: "This view will load by default next time",
        });
      }}
      onClearDefaults={() => {
        prefs.clearSavedDefaults();
        prefs.resetFilters();
        onSearchChange("");
        toast.info("Defaults cleared", {
          description: "Reset to system defaults",
        });
      }}
      hasSavedDefaults={prefs.hasSavedDefaults}
    />
  );

  // Column visibility helper
  const isColVisible = prefs.isColumnVisible;

  // Count visible columns for colspan (includes actions column)
  const visibleColCount =
    (isColVisible("event") ? 1 : 0) +
    (isColVisible("competition") ? 1 : 0) +
    (isColVisible("market") ? 1 : 0) +
    (isColVisible("outcome") ? 1 : 0) +
    visibleProviders.length +
    (isColVisible("best") ? 1 : 0) +
    (isColVisible("ev") ? 1 : 0) +
    1; // Actions column

  // Resize handle component
  const ResizeHandle = ({ col }: { col: string }) => (
    <div
      className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-blue-500 active:bg-blue-600"
      onMouseDown={(e) => handleResizeStart(col, e)}
    />
  );

  // Get virtual items for rendering
  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  // Spreadsheet view with virtualization
  const tableContent = (
    <div
      ref={tableContainerRef}
      className="flex-1 overflow-auto table-container"
      style={columnSizeVars as React.CSSProperties}
    >
      <table className="w-full text-xs border-collapse table-fixed spreadsheet-table">
        <thead className="sticky top-0 z-10">
          <tr className="bg-muted border-b-2 border-border">
            {isColVisible("event") && (
              <th
                className="text-left px-3 py-2 font-semibold text-foreground sticky left-0 bg-muted relative"
                style={{ width: "calc(var(--col-event-size) * 1px)" }}
              >
                Event
                <ResizeHandle col="event" />
              </th>
            )}
            {isColVisible("competition") && (
              <th
                className="text-left px-2 py-2 font-semibold text-foreground relative"
                style={{ width: "calc(var(--col-competition-size) * 1px)" }}
              >
                Competition
                <ResizeHandle col="competition" />
              </th>
            )}
            {isColVisible("market") && (
              <th
                className="text-left px-2 py-2 font-semibold text-foreground relative"
                style={{ width: "calc(var(--col-market-size) * 1px)" }}
              >
                Market
                <ResizeHandle col="market" />
              </th>
            )}
            {isColVisible("outcome") && (
              <th
                className="text-left px-2 py-2 font-semibold text-foreground relative"
                style={{ width: "calc(var(--col-outcome-size) * 1px)" }}
              >
                Outcome
                <ResizeHandle col="outcome" />
              </th>
            )}
            {visibleProviders.map((providerId) => (
              <th
                key={providerId}
                className={`text-center px-2 py-2 font-semibold ${getProviderBadgeClasses(providerId)}`}
                style={{ width: "calc(var(--col-provider-size) * 1px)" }}
              >
                {getProviderShortName(providerId)}
              </th>
            ))}
            {isColVisible("best") && (
              <th
                className="text-center px-2 py-2 font-semibold text-foreground"
                style={{ width: "calc(var(--col-best-size) * 1px)" }}
              >
                Best
              </th>
            )}
            {isColVisible("ev") && (
              <th
                className="text-center px-2 py-2 font-semibold text-foreground bg-cyan-900/20"
                style={{ width: "calc(var(--col-ev-size) * 1px)" }}
              >
                EV %
              </th>
            )}
            <th
              className="text-center px-2 py-2 font-semibold text-foreground"
              style={{ width: "calc(var(--col-actions-size) * 1px)" }}
            >
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={visibleColCount}
                className="px-4 py-8 text-center text-sm text-muted-foreground"
              >
                {isLoading ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    Loading events...
                  </span>
                ) : events.length === 0 ? (
                  isSyncing ? (
                    "Sync in progress. Events will appear shortly..."
                  ) : searchTerm ? (
                    `No events found matching "${searchTerm}". Try a different search term.`
                  ) : prefs.hasActiveFilters ? (
                    "No events match current filters. Try adjusting or resetting filters."
                  ) : (
                    "No matched events found. Try triggering a sync."
                  )
                ) : searchTerm ? (
                  `No events found matching "${searchTerm}". Try a different search term.`
                ) : (
                  "No rows match current filters. Try adjusting your filter settings."
                )}
              </td>
            </tr>
          ) : (
            <>
              {/* Spacer row for virtualization - positions content correctly */}
              {virtualItems.length > 0 && (
                <tr style={{ height: virtualItems[0].start }} />
              )}
              {/* Virtualized rows */}
              {virtualItems.map((virtualRow) => {
                const row = rows[virtualRow.index];
                const index = virtualRow.index;
                return (
                  <SpreadsheetRowComponent
                    key={row.rowId}
                    row={row}
                    visibleProviders={visibleProviders}
                    hiddenColumns={prefs.hiddenColumns}
                    isLastInFamily={
                      index === rows.length - 1 ||
                      rows[index + 1]?.familyId !== row.familyId ||
                      rows[index + 1]?.eventId !== row.eventId
                    }
                    now={now}
                    isRefreshing={refreshingEvents.has(row.eventId)}
                    onRefresh={handleRefreshEvent}
                    eventProviders={
                      eventProvidersMap.get(row.eventId)?.providers || []
                    }
                    providerEventIds={
                      eventProvidersMap.get(row.eventId)?.providerEventIds || {}
                    }
                    copyingRawData={copyingRawData}
                    onSelectValueBet={setSelectedValueBet}
                    onCopyRawData={handleCopyRawData}
                    onHide={handleHideFamily}
                    liveScore={eventProvidersMap.get(row.eventId)?.liveScore}
                    suspended={eventProvidersMap.get(row.eventId)?.suspended}
                  />
                );
              })}
              {/* Bottom spacer for virtualization */}
              {virtualItems.length > 0 && (
                <tr
                  style={{
                    height:
                      totalSize -
                      (virtualItems[virtualItems.length - 1]?.end ?? 0),
                  }}
                />
              )}
              {/* Loading more indicator */}
              {isFetchingNextPage && (
                <tr>
                  <td
                    colSpan={visibleColCount}
                    className="px-4 py-3 text-center text-sm text-muted-foreground"
                  >
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="size-4 animate-spin" />
                      Loading more events...
                    </span>
                  </td>
                </tr>
              )}
              {/* End of data indicator */}
              {!hasNextPage &&
                totalCount !== undefined &&
                totalCount > 0 &&
                rows.length > 0 && (
                  <tr>
                    <td
                      colSpan={visibleColCount}
                      className="px-4 py-2 text-center text-xs text-muted-foreground/60"
                    >
                      Showing all {rows.length} rows
                      {totalCount !== rows.length &&
                        ` (${totalCount} total before filters)`}
                    </td>
                  </tr>
                )}
            </>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <Card className="flex flex-col h-full relative overflow-hidden py-0 gap-0">
        {/* Toolbar - always visible at top */}
        {toolbar}
        {/* Table with internal scrolling and sticky thead */}
        {tableContent}

        {/* Hidden items restore button */}
        {hiddenFamilies.size > 0 && (
          <div className="absolute bottom-4 left-4 z-50">
            <Button
              onClick={handleRestoreAllHidden}
              variant="secondary"
              className="shadow-lg"
            >
              <Eye className="size-4" />
              Restore {hiddenFamilies.size} hidden
            </Button>
          </div>
        )}
      </Card>

      {/* Value Bet Details Modal */}
      {selectedValueBet &&
        (() => {
          // Split "Home vs Away" — eventLabel is formatted by
          // transformToSpreadsheetRows so this is stable.
          const [homeTeam, awayTeam] =
            selectedValueBet.eventLabel.split(" vs ");
          return (
            <ValueBetDetailsModal
              open={true}
              onOpenChange={(open) => !open && setSelectedValueBet(null)}
              eventLabel={selectedValueBet.eventLabel}
              competition={selectedValueBet.competition}
              startTime={selectedValueBet.startTime}
              marketLabel={selectedValueBet.marketLabel}
              outcomeLabel={selectedValueBet.outcomeLabel}
              details={selectedValueBet.details}
              atomOdds={selectedValueBet.atomOdds}
              eventId={selectedValueBet.eventId}
              providerEventIds={selectedValueBet.providerEventIds}
              liveScore={selectedValueBet.liveScore}
              onRefresh={handleRefreshEvent}
              isRefreshing={refreshingEvents.has(selectedValueBet.eventId)}
              isSyncing={isSyncing}
              placementContext={{
                familyId: selectedValueBet.familyId,
                atomId: selectedValueBet.atomId,
                atomLabel: selectedValueBet.outcomeLabel,
                homeTeam: homeTeam ?? selectedValueBet.eventLabel,
                awayTeam: awayTeam ?? "",
                marketType: selectedValueBet.marketType,
                eventStartTime: selectedValueBet.startTime,
                competition: selectedValueBet.competition,
              }}
            />
          );
        })()}
    </>
  );
}

// ============================================
// Spreadsheet Row Component
// ============================================

interface LiveScoreData {
  home: number;
  away: number;
  minute: number;
  period: string;
  homeRedCards: number;
  awayRedCards: number;
  // Multi-source metadata
  primarySource?: "pinnacle" | "betconstruct";
  confidence?: "high" | "medium" | "low" | "stale";
  hasDiscrepancy?: boolean;
  alternativeScore?: {
    source: "pinnacle" | "betconstruct";
    home: number;
    away: number;
  };
}

interface SpreadsheetRowComponentProps {
  row: SpreadsheetRow;
  visibleProviders: ProviderKey[];
  hiddenColumns: Set<string>;
  isLastInFamily: boolean;
  now: number;
  isRefreshing: boolean;
  onRefresh: (
    eventId: string,
    providerEventIds?: Record<string, string>,
    eventLabel?: string,
  ) => void;
  eventProviders: ProviderKey[];
  providerEventIds: Record<string, string>;
  copyingRawData: string | null;
  onSelectValueBet: (data: {
    eventLabel: string;
    competition: string;
    startTime: string;
    marketLabel: string;
    outcomeLabel: string;
    atomId: string;
    familyId: string;
    marketType: string;
    details: ValueBetDetails;
    eventId: string;
    providerEventIds: Record<string, string>;
    atomOdds: SpreadsheetRow["odds"];
    liveScore?: LiveMatchInfo;
  }) => void;
  onCopyRawData: (
    eventId: string,
    provider: ProviderKey,
    providerEventId?: string,
  ) => void;
  onHide: (eventId: string, familyId: string) => void;
  liveScore?: LiveScoreData;
  /** Event-level suspension (all markets blocked) */
  suspended?: boolean;
}

function SpreadsheetRowComponent({
  row,
  visibleProviders,
  hiddenColumns,
  isLastInFamily,
  now,
  isRefreshing,
  onRefresh,
  eventProviders,
  providerEventIds,
  copyingRawData,
  onSelectValueBet,
  onCopyRawData,
  onHide,
  liveScore,
  suspended,
}: SpreadsheetRowComponentProps) {
  const isVisible = (col: string) => !hiddenColumns.has(col);

  const rowClasses = [
    "group", // For hover-based action visibility
    "hover:bg-muted/50",
    // Value betting: highlight rows with value
    row.hasValue && "bg-cyan-900/5",
    row.isFirstFamilyInEvent && "border-t-2 border-border",
    row.isFirstAtomInFamily &&
      !row.isFirstFamilyInEvent &&
      "border-t border-border/50",
    isLastInFamily && "border-b border-border/50",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <tr className={rowClasses}>
      {/* Event */}
      {isVisible("event") && (
        <td className="px-3 py-1.5 text-foreground sticky left-0 bg-card overflow-hidden">
          {row.isFirstFamilyInEvent && row.isFirstAtomInFamily ? (
            <div className="flex items-center gap-1.5 min-w-0">
              {/* Suspended badge (event-level) */}
              {suspended && (
                <Badge
                  variant="outline"
                  className="px-1 py-0 text-[9px] font-bold uppercase h-4 shrink-0 bg-yellow-900/40 text-yellow-400 border-yellow-600/50"
                >
                  Blocked
                </Badge>
              )}
              {/* Live badge (if live) */}
              {new Date(row.startTime) <= new Date() && (
                <Badge
                  variant="destructive"
                  className="px-1 py-0 text-[9px] font-bold uppercase h-4 shrink-0"
                >
                  Live
                </Badge>
              )}
              {/* Team names */}
              <span className="font-medium truncate" title={row.eventLabel}>
                {row.eventLabel}
              </span>
              {/* Score + time (live) or scheduled time */}
              {new Date(row.startTime) <= new Date() ? (
                liveScore && (
                  <>
                    <span className="text-muted-foreground/50 shrink-0">|</span>
                    {/* Discrepancy warning */}
                    {liveScore.hasDiscrepancy && (
                      <span
                        className="text-yellow-500 shrink-0"
                        title={`Score mismatch! Pinnacle: ${liveScore.alternativeScore?.source === "pinnacle" ? `${liveScore.alternativeScore.home}-${liveScore.alternativeScore.away}` : `${liveScore.home}-${liveScore.away}`}, BC: ${liveScore.alternativeScore?.source === "betconstruct" ? `${liveScore.alternativeScore.home}-${liveScore.alternativeScore.away}` : `${liveScore.home}-${liveScore.away}`}`}
                      >
                        !
                      </span>
                    )}
                    {/* Score */}
                    <span className="font-mono font-bold text-xs text-yellow-400 shrink-0">
                      {liveScore.home}-{liveScore.away}
                    </span>
                    {/* Minute */}
                    <span className="text-muted-foreground text-[10px] shrink-0">
                      {liveScore.minute}&apos;
                    </span>
                    {/* Source badge */}
                    {liveScore.primarySource && (
                      <span
                        className={`text-[8px] px-0.5 rounded shrink-0 ${
                          liveScore.primarySource === "pinnacle"
                            ? "bg-blue-900/40 text-blue-300"
                            : "bg-purple-900/40 text-purple-300"
                        } ${
                          liveScore.confidence === "stale"
                            ? "opacity-50"
                            : liveScore.confidence === "low"
                              ? "ring-1 ring-yellow-500"
                              : ""
                        }`}
                        title={`Source: ${liveScore.primarySource === "pinnacle" ? "Pinnacle WS" : "BetConstruct"} (${liveScore.confidence || "medium"} confidence)`}
                      >
                        {liveScore.primarySource === "pinnacle" ? "P" : "BC"}
                      </span>
                    )}
                    {/* Red cards */}
                    {(liveScore.homeRedCards > 0 ||
                      liveScore.awayRedCards > 0) && (
                      <span
                        className="text-red-500 font-bold text-[10px] shrink-0"
                        title="Red cards"
                      >
                        {liveScore.homeRedCards + liveScore.awayRedCards}R
                      </span>
                    )}
                  </>
                )
              ) : (
                <span className="text-muted-foreground text-[10px] shrink-0">
                  {formatEventTime(row.startTime)}
                </span>
              )}
            </div>
          ) : null}
        </td>
      )}

      {/* Competition */}
      {isVisible("competition") && (
        <td className="px-2 py-1.5 text-muted-foreground overflow-hidden">
          {row.isFirstFamilyInEvent && row.isFirstAtomInFamily ? (
            <span className="truncate block" title={row.competition}>
              {row.competition}
            </span>
          ) : null}
        </td>
      )}

      {/* Market */}
      {isVisible("market") && (
        <td className="px-2 py-1.5 text-foreground overflow-hidden">
          {row.isFirstAtomInFamily ? (
            <span className="truncate block" title={row.marketLabel}>
              {row.marketLabel}
            </span>
          ) : null}
        </td>
      )}

      {/* Outcome */}
      {isVisible("outcome") && (
        <td className="px-2 py-1.5 text-foreground">{row.outcomeLabel}</td>
      )}

      {/* Provider Odds — placeable cells are clickable; click opens the
          placement modal with that specific provider pre-selected so the
          operator can place a bet at the exact price they clicked. */}
      {visibleProviders.map((providerId) => {
        const od = row.odds[providerId];
        const placeable =
          CONFIGURED_BETTING_PROVIDER_IDS.includes(providerId as string) &&
          !!od &&
          !od.suspended;
        const onClick = placeable
          ? () => {
              const price = od!.value;
              // Prefer the row's real sharp baseline when present (keeps
              // true EV%); otherwise synthesize a zero-EV shell so the
              // modal's place flow still works for rows without sharp odds.
              const baseline = row.valueBetDetails;
              const details: ValueBetDetails = baseline
                ? {
                    sharpProvider: baseline.sharpProvider,
                    sharpOdds: baseline.sharpOdds,
                    trueProb: baseline.trueProb,
                    softProvider: providerId,
                    softOdds: price,
                    impliedProb: 1 / price,
                    edge: baseline.trueProb - 1 / price,
                    evPct: (price * baseline.trueProb - 1) * 100,
                    kellyFraction: Math.max(
                      0,
                      ((price - 1) * baseline.trueProb -
                        (1 - baseline.trueProb)) /
                        (price - 1),
                    ),
                    kellyStake: 0, // modal recalculates from selected provider
                    timestamp: od!.timestamp,
                    familyOdds: baseline.familyOdds,
                  }
                : {
                    sharpProvider: providerId,
                    sharpOdds: price,
                    trueProb: 1 / price,
                    softProvider: providerId,
                    softOdds: price,
                    impliedProb: 1 / price,
                    edge: 0,
                    evPct: 0,
                    kellyFraction: 0,
                    kellyStake: 0,
                    timestamp: od!.timestamp,
                  };
              onSelectValueBet({
                eventLabel: row.eventLabel,
                competition: row.competition,
                startTime: row.startTime,
                marketLabel: row.marketLabel,
                outcomeLabel: row.outcomeLabel,
                atomId: row.atomId,
                familyId: row.familyId,
                marketType: row.marketType,
                details,
                eventId: row.eventId,
                providerEventIds,
                atomOdds: row.odds,
                liveScore,
              });
            }
          : undefined;
        return (
          <OddsCell key={providerId} odds={od} now={now} onClick={onClick} />
        );
      })}

      {/* Best Odds */}
      {isVisible("best") && (
        <td className="text-center px-2 py-1.5 font-mono text-xs font-bold text-green-700 dark:text-green-400">
          {row.bestOdds?.toFixed(2) ?? "-"}
        </td>
      )}

      {/* EV % cell — always shows calculated EV when sharp data exists (positive or
          negative). Always clickable for manual placement: uses real valueBetDetails
          when available, otherwise synthesizes a zero-EV shell from the best
          placeable provider so the modal's place flow still works. */}
      {isVisible("ev") && (
        <td
          className={`text-center px-2 py-1.5 font-mono text-xs bg-cyan-50/30 dark:bg-cyan-900/10 cursor-pointer hover:bg-cyan-100/50 dark:hover:bg-cyan-900/30`}
          onClick={() => {
            // Resolve details: use real sharp-backed data, or synthesize from
            // the top placeable provider for rows without a sharp baseline.
            const details: ValueBetDetails | null =
              row.valueBetDetails ??
              (() => {
                const top = CONFIGURED_BETTING_PROVIDER_IDS.map((pid) => {
                  const od = row.odds[pid as ProviderKey];
                  if (!od || od.suspended) return null;
                  return { provider: pid as ProviderKey, odds: od };
                })
                  .filter((x): x is NonNullable<typeof x> => x !== null)
                  .reduce<{
                    provider: ProviderKey;
                    odds: { value: number; timestamp: number };
                  } | null>(
                    (a, b) => (!a || b.odds.value > a.odds.value ? b : a),
                    null,
                  );
                if (!top) return null;
                const price = top.odds.value;
                return {
                  sharpProvider: top.provider,
                  sharpOdds: price,
                  trueProb: 1 / price,
                  softProvider: top.provider,
                  softOdds: price,
                  impliedProb: 1 / price,
                  edge: 0,
                  evPct: 0,
                  kellyFraction: 0,
                  kellyStake: 0,
                  timestamp: top.odds.timestamp,
                };
              })();
            if (!details) return;
            onSelectValueBet({
              eventLabel: row.eventLabel,
              competition: row.competition,
              startTime: row.startTime,
              marketLabel: row.marketLabel,
              outcomeLabel: row.outcomeLabel,
              atomId: row.atomId,
              familyId: row.familyId,
              marketType: row.marketType,
              details,
              eventId: row.eventId,
              providerEventIds,
              atomOdds: row.odds,
              liveScore,
            });
          }}
          title="Click to open placement details"
        >
          {row.evPct !== null ? (
            <div className="flex flex-col items-center">
              <span
                className={
                  row.hasValue
                    ? "font-bold text-cyan-600 dark:text-cyan-400"
                    : "text-muted-foreground/70"
                }
              >
                {row.evPct >= 0 ? "+" : ""}
                {row.evPct.toFixed(2)}%
              </span>
              {row.hasValue &&
                row.valueBetDetails?.kellyFraction != null &&
                row.valueBetDetails.kellyFraction > 0 && (
                  <span className="text-[10px] text-cyan-500 dark:text-cyan-400/70 mt-0.5">
                    {(row.valueBetDetails.kellyFraction * 100).toFixed(2)}%
                    Kelly
                  </span>
                )}
              {row.hasValue &&
                (() => {
                  const valueCount = countValueProviders(
                    row.odds,
                    row.valueBetDetails?.trueProb ?? null,
                  );
                  return valueCount > 1 ? (
                    <span className="text-[9px] text-muted-foreground mt-0.5">
                      {valueCount} providers
                    </span>
                  ) : null;
                })()}
            </div>
          ) : (
            <span className="text-muted-foreground/40">-</span>
          )}
        </td>
      )}

      {/* Actions */}
      <td className="text-center px-2 py-1.5">
        <div className="flex items-center justify-center gap-1">
          {/* Event-level actions: Refresh & Copy (visible on hover only) */}
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {/* Refresh button - requires refresh-event permission */}
            <Feature id="refresh-event">
              <LoadingButton
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={() =>
                  onRefresh(row.eventId, providerEventIds, row.eventLabel)
                }
                loading={isRefreshing}
                icon={RefreshCw}
                iconClassName="size-3.5"
                title="Refresh odds for this event"
              />
            </Feature>
            {/* Copy raw data dropdown - requires copy-odds permission */}
            <Feature id="copy-odds">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <LoadingButton
                    variant="secondary"
                    size="icon"
                    className="size-6"
                    title="Copy raw API data"
                    loading={
                      copyingRawData?.startsWith(`${row.eventId}:`) ?? false
                    }
                    icon={Copy}
                    iconClassName="size-3.5"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {eventProviders.map((provider) => {
                    const providerEventId = providerEventIds[provider];
                    return (
                      <DropdownMenuItem
                        key={provider}
                        onClick={() =>
                          onCopyRawData(row.eventId, provider, providerEventId)
                        }
                      >
                        <span
                          className={
                            getProviderBadgeClasses(provider) +
                            " px-1.5 py-0.5 rounded text-xs mr-2"
                          }
                        >
                          {getProviderShortName(provider)}
                        </span>
                        Copy raw data
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </Feature>
          </div>
          {/* Family-level action: Hide (on first atom of each family, always visible) */}
          {row.isFirstAtomInFamily && (
            <Button
              variant="ghost"
              size="icon"
              className="size-5 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              onClick={() => onHide(row.eventId, row.familyId)}
              title="Hide this market"
            >
              <X className="size-3" />
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}
