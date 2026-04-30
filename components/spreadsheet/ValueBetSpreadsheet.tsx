"use client";

/**
 * Value-bets spreadsheet — the grid on /value-bets.
 *
 * This file orchestrates state (filters, selection, modals, refresh) and
 * composes the extracted sub-components:
 *   - [OddsCell](./OddsCell.tsx)            — single provider-odds cell
 *   - [SpreadsheetRow](./SpreadsheetRow.tsx) — one rendered row
 *   - [useSpreadsheetColumnWidths](./useSpreadsheetColumnWidths.ts) — resize hook
 *   - [SpreadsheetToolbar](./SpreadsheetToolbar.tsx)                 — filter bar
 *   - [ValueBetDetailsModal](./ValueBetDetailsModal.tsx)             — placement modal
 *
 * The table itself uses `<table>` + `@tanstack/react-virtual` directly
 * rather than going through `components/ui/data-table.tsx` because the
 * row rendering is highly positional (first-atom-of-first-family-of-event
 * shows the event header, etc.), which doesn't map cleanly onto a flat
 * TanStack column model. The new DataTable is used for Bets History; this
 * one stays bespoke.
 */

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2, Eye, ArrowDown, ArrowUp } from "lucide-react";
import { toast } from "sonner";
import {
  PROVIDER_IDS,
  getProviderShortName,
  getProviderColorClasses,
  type ProviderKey,
} from "@/lib/providers/registry";
import {
  transformToSpreadsheetRows,
  type ValueBetEvent,
  type SpreadsheetRow as SpreadsheetRowData,
} from "@/lib/formatting/spreadsheet";
import { useBulkAnalysisPreferences } from "@/components/hooks/useBulkAnalysisPreferences";
import { useLocalStorage } from "@/components/hooks/useLocalStorage";
import { useProviderRuntimeState } from "@/components/hooks/useProviderRuntimeState";
import { useApplicableStrategies } from "@/lib/optimizer/use-live-strategies";
import {
  strategyToValueBetPrefs,
  valueBetPrefsMatchTemplate,
} from "@/lib/optimizer/apply-strategy-to-prefs";
import type { StrategyFilters } from "@/lib/optimizer/strategy-filters";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SpreadsheetToolbar } from "./SpreadsheetToolbar";
import {
  ValueBetDetailsModal,
  type LiveMatchInfo,
  type ValueBetDetails,
} from "./ValueBetDetailsModal";
import { SpreadsheetRow } from "./SpreadsheetRow";
import { useSpreadsheetColumnWidths } from "./useSpreadsheetColumnWidths";
import { MovementDetailModal } from "@/components/bets-history/MovementDetailModal";
import type { OddsMovementData } from "@/lib/bets-history/types";
import type { AtomOddsData } from "@/lib/formatting/spreadsheet";

const DEFAULT_COLUMN_WIDTHS: Record<string, number> = {
  event: 320,
  ko: 90,
  market: 150,
  outcome: 90,
  provider: 70,
  ev: 100,
  kelly: 70,

  actions: 100,
};

interface ValueBetSpreadsheetProps {
  events: ValueBetEvent[];
  isLoading?: boolean;
  isEngineWarming?: boolean;
  onRefreshComplete?: () => void;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  totalCount?: number;
  searchTerm?: string;
  onSearchChange?: (value: string) => void;
}

type SelectedValueBet = {
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
  atomOdds: SpreadsheetRowData["odds"];
  liveScore?: LiveMatchInfo;
};

export function ValueBetSpreadsheet({
  events,
  isLoading = false,
  isEngineWarming = false,
  onRefreshComplete,
  hasNextPage = false,
  isFetchingNextPage = false,
  onLoadMore,
  totalCount,
  searchTerm: controlledSearchTerm,
  onSearchChange: controlledOnSearchChange,
}: ValueBetSpreadsheetProps) {
  const prefs = useBulkAnalysisPreferences();
  const providerRuntime = useProviderRuntimeState();

  const [selectedValueBet, setSelectedValueBet] =
    useState<SelectedValueBet | null>(null);

  // Movement chart modal state
  const [movementModal, setMovementModal] = useState<{
    data: OddsMovementData;
    eventLabel: string;
    marketLabel: string;
  } | null>(null);

  const handleMovementClick = useCallback(
    (
      movement: NonNullable<AtomOddsData["movement"]>,
      context: { eventLabel: string; marketLabel: string; providerLabel: string },
    ) => {
      setMovementModal({
        data: {
          provider: context.providerLabel,
          openingOdds: movement.openingOdds,
          peakOdds: movement.peakOdds,
          troughOdds: movement.troughOdds,
          totalTicks: movement.totalTicks,
          sparkline: movement.sparkline,
        },
        eventLabel: context.eventLabel,
        marketLabel: `${context.marketLabel} · ${context.providerLabel}`,
      });
    },
    [],
  );

  const searchTerm = controlledSearchTerm ?? prefs.searchTerm;
  const onSearchChange = controlledOnSearchChange ?? prefs.setSearchTerm;

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

  // Defer filter values — UI updates immediately, expensive recomputation
  // follows. `showOnlyValue` is NOT deferred because it changes which data
  // is fetched, not how existing data is filtered.
  const deferredFilters = useDeferredValue({
    selectedProviders: effectiveSelectedProviders,
    searchTerm,
    selectedMarketTypes: prefs.selectedMarketTypes,
    timeFilter: prefs.timeFilter,
    suspiciousThresholdPct: prefs.suspiciousThresholdPct,
    minEvPct: prefs.minEvPct,
  });

  const transformFilters = useMemo(
    () => ({
      ...deferredFilters,
      showOnlyValue: prefs.showOnlyValue,
    }),
    [deferredFilters, prefs.showOnlyValue],
  );



  const [copyingRawData, setCopyingRawData] = useState<string | null>(null);
  const [hiddenFamilies, setHiddenFamilies] = useState<Set<string>>(new Set());

  const handleHideFamily = useCallback((eventId: string, familyId: string) => {
    setHiddenFamilies((prev) => new Set(prev).add(`${eventId}|${familyId}`));
  }, []);

  const handleRestoreAllHidden = useCallback(() => {
    setHiddenFamilies(new Set());
  }, []);

  const { columnSizeVars, handleResizeStart } = useSpreadsheetColumnWidths(
    DEFAULT_COLUMN_WIDTHS,
  );

  // Copy a provider's raw JSON response for the given event.
  const handleCopyRawData = useCallback(
    async (
      eventId: string,
      provider: ProviderKey,
      providerEventId?: string,
    ) => {
      const key = `${eventId}:${provider}`;
      setCopyingRawData(key);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      try {
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

  const visibleProviders = useMemo(
    () =>
      PROVIDER_IDS.filter(
        (p) => runtimeEnabledProviders.has(p) && prefs.selectedProviders.has(p),
      ),
    [runtimeEnabledProviders, prefs.selectedProviders],
  );

  // Strategy = filter template. Picking a strategy populates the toolbar's
  // strategy-mapped prefs (EV cutoff, soft-odds range, providers, markets)
  // so the user can see exactly what's being filtered and adjust further.
  // Multi-select uses the loosest merge across selected strategies.
  const [appliedStrategyIds, setAppliedStrategyIds] = useLocalStorage<string[]>(
    "value-bets:applied-strategies",
    [],
  );
  const { data: strategies } = useApplicableStrategies();
  const appliedStrategyFilters = useMemo<StrategyFilters[]>(() => {
    if (appliedStrategyIds.length === 0 || !strategies) return [];
    return appliedStrategyIds
      .map((id) => strategies.find((s) => s.id === id))
      .filter((s): s is NonNullable<typeof s> => s != null)
      .map((s) => s.filters as StrategyFilters);
  }, [appliedStrategyIds, strategies]);

  const isStrategyModified = useMemo(() => {
    if (appliedStrategyFilters.length === 0) return false;
    return !valueBetPrefsMatchTemplate(
      {
        evRangeMin: prefs.evRangeMin,
        softOddsRangeMin: prefs.softOddsRangeMin,
        softOddsRangeMax: prefs.softOddsRangeMax,
        selectedSoftProviders: new Set(prefs.selectedSoftProviders),
        selectedMarketTypes: prefs.selectedMarketTypes,
      },
      appliedStrategyFilters,
    );
  }, [
    prefs.evRangeMin,
    prefs.softOddsRangeMin,
    prefs.softOddsRangeMax,
    prefs.selectedSoftProviders,
    prefs.selectedMarketTypes,
    appliedStrategyFilters,
  ]);

  const handleAppliedStrategiesChange = useCallback(
    (ids: string[]) => {
      setAppliedStrategyIds(ids);
      const list = strategies ?? [];
      const picked = ids
        .map((id) => list.find((s) => s.id === id))
        .filter((s): s is NonNullable<typeof s> => s != null)
        .map((s) => s.filters as StrategyFilters);
      const patch = strategyToValueBetPrefs(picked);
      prefs.setEvRangeMin(patch.evRangeMin);
      prefs.setSoftOddsRangeMin(patch.softOddsRangeMin);
      prefs.setSoftOddsRangeMax(patch.softOddsRangeMax);
      prefs.setSelectedSoftProviders(
        patch.selectedSoftProviders as Set<ProviderKey>,
      );
      prefs.setSelectedMarketTypes(patch.selectedMarketTypes);
    },
    [setAppliedStrategyIds, strategies, prefs],
  );

  const allRows = useMemo(
    () => transformToSpreadsheetRows(events, transformFilters),
    [events, transformFilters],
  );

  // Apply hidden-families + suspicious filters, apply event-group sort,
  // then recompute isFirst/isLast flags (they were computed pre-filter).
  const rows = useMemo(() => {
    let filtered = allRows;

    if (hiddenFamilies.size > 0) {
      filtered = filtered.filter(
        (row) => !hiddenFamilies.has(`${row.eventId}|${row.familyId}`),
      );
    }

    if (prefs.showOnlySuspicious) {
      filtered = filtered.filter((row) => row.isSuspicious);
    }

    // Event-group sort: click-to-sort reorders events without splitting
    // family groups. Each event's score is derived from its atoms.
    const { key, dir } = prefs.tableSort;
    if (key) {
      const groups = new Map<string, SpreadsheetRowData[]>();
      const order: string[] = [];
      for (const r of filtered) {
        if (!groups.has(r.eventId)) {
          groups.set(r.eventId, []);
          order.push(r.eventId);
        }
        groups.get(r.eventId)!.push(r);
      }

      const eventScore = (rows: SpreadsheetRowData[]): number => {
        switch (key) {
          case "ko":
            return new Date(rows[0]?.startTime ?? 0).getTime();
          case "ev":
            return Math.max(
              0,
              ...rows.map((r) => (r.hasValue ? (r.evPct ?? 0) : -Infinity)),
            );
          case "kelly":
            return Math.max(
              0,
              ...rows.map((r) => r.valueBetDetails?.kellyFraction ?? 0),
            );
          case "captured": {
            let maxTs = 0;
            for (const r of rows) {
              for (const od of Object.values(r.odds)) {
                if (od && od.timestamp > maxTs) maxTs = od.timestamp;
              }
            }
            return maxTs;
          }
          default:
            return 0;
        }
      };

      const sortedIds = [...order].sort((a, b) => {
        const sa = eventScore(groups.get(a)!);
        const sb = eventScore(groups.get(b)!);
        return dir === "desc" ? sb - sa : sa - sb;
      });

      const sorted: SpreadsheetRowData[] = [];
      for (const id of sortedIds) sorted.push(...groups.get(id)!);
      filtered = sorted;
    }

    let lastEventId: string | null = null;
    let lastFamilyKey: string | null = null;

    return filtered.map((row, index) => {
      const isFirstFamilyInEvent = row.eventId !== lastEventId;
      const familyKey = `${row.eventId}|${row.familyId}`;
      const isFirstAtomInFamily = familyKey !== lastFamilyKey;
      const isLastAtomInEvent =
        index === filtered.length - 1 ||
        filtered[index + 1]?.eventId !== row.eventId;

      lastEventId = row.eventId;
      lastFamilyKey = familyKey;

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
  }, [allRows, hiddenFamilies, prefs.showOnlySuspicious, prefs.tableSort]);

  const valueRowCount = useMemo(() => {
    const unique = new Set<string>();
    for (const row of rows) {
      if (row.hasValue) unique.add(`${row.eventId}|${row.familyId}`);
    }
    return unique.size;
  }, [rows]);

  const suspiciousCount = useMemo(() => {
    const unique = new Set<string>();
    for (const row of allRows) {
      if (row.isSuspicious) unique.add(`${row.eventId}|${row.familyId}`);
    }
    return unique.size;
  }, [allRows]);

  // Keep the open modal's details in sync when the underlying row data
  // refreshes (e.g. after the reactive engine pushes new odds).
  useEffect(() => {
    if (!selectedValueBet) return;

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
    // Subfield deps only — depending on the full `selectedValueBet` would
    // re-fire this effect on its own setState and oscillate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    allRows,
    eventProvidersMap,
    selectedValueBet?.eventId,
    selectedValueBet?.atomId,
    selectedValueBet?.details.timestamp,
    selectedValueBet?.liveScore,
    selectedValueBet?.providerEventIds,
  ]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => 30,
    overscan: 15,
  });

  // Infinite-scroll: fetch more when 80% scrolled.
  useEffect(() => {
    const container = tableContainerRef.current;
    if (!container || !onLoadMore || !hasNextPage || isFetchingNextPage) return;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      if (scrollTop + clientHeight >= scrollHeight * 0.8) {
        onLoadMore();
      }
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [hasNextPage, isFetchingNextPage, onLoadMore]);

  // Filters can leave us with <10 visible rows on the first page — auto-load
  // more so the viewport doesn't feel empty.
  useEffect(() => {
    if (!onLoadMore || !hasNextPage || isFetchingNextPage) return;
    if (events.length > 0 && rows.length < 10) {
      onLoadMore();
    }
  }, [events.length, rows.length, hasNextPage, isFetchingNextPage, onLoadMore]);

  // All columns always render now — column filtering was retired.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const isColVisible = (col: string) => true;

  const visibleColCount =
    // event (+ competition inline), ko, market, outcome, ev, kelly
    6 + visibleProviders.length + 1; // + actions

  const ResizeHandle = ({ col }: { col: string }) => (
    <div
      className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-blue-500 active:bg-blue-600"
      onMouseDown={(e) => handleResizeStart(col, e)}
    />
  );

  // Small tri-state header indicator — clicking cycles desc → asc → off.
  // Matches the pattern used in BetsHistoryTable so the two tables look
  // and behave the same.
  const SortIndicator = ({ col }: { col: typeof prefs.tableSort.key }) => {
    const active = prefs.tableSort.key === col;
    if (!active) return null;
    return prefs.tableSort.dir === "desc" ? (
      <ArrowDown className="size-3 opacity-80" />
    ) : (
      <ArrowUp className="size-3 opacity-80" />
    );
  };
  const sortButtonClass =
    "inline-flex items-center gap-1 cursor-pointer select-none hover:text-foreground";

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  const toolbar = (
    <SpreadsheetToolbar
      showOnlyValue={prefs.showOnlyValue}
      onToggleShowOnlyValue={() => prefs.setShowOnlyValue(!prefs.showOnlyValue)}
      valueRowCount={valueRowCount}
      selectedMarketTypes={prefs.selectedMarketTypes}
      onMarketsChange={(markets) =>
        prefs.setSelectedMarketTypes(new Set(markets))
      }
      selectedSoftProviders={prefs.selectedSoftProviders}
      onSoftProvidersChange={(providers) =>
        prefs.setSelectedSoftProviders(
          new Set(providers) as Parameters<
            typeof prefs.setSelectedSoftProviders
          >[0],
        )
      }
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
      timeFilter={prefs.timeFilter}
      onTimeFilterChange={prefs.setTimeFilter}
      showOnlySuspicious={prefs.showOnlySuspicious}
      onToggleShowOnlySuspicious={() =>
        prefs.setShowOnlySuspicious(!prefs.showOnlySuspicious)
      }
      suspiciousCount={suspiciousCount}
      suspiciousThresholdPct={prefs.suspiciousThresholdPct}
      onSuspiciousThresholdChange={prefs.setSuspiciousThresholdPct}
      searchTerm={searchTerm}
      onSearchChange={onSearchChange}
      totalRows={rows.length}
      onReset={() => {
        prefs.resetFilters();
        onSearchChange("");
        setAppliedStrategyIds([]);
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
      appliedStrategyIds={appliedStrategyIds}
      onAppliedStrategiesChange={handleAppliedStrategiesChange}
      strategyTemplateModified={isStrategyModified}
    />
  );

  const tableContent = (
    <div
      ref={tableContainerRef}
      className="flex-1 overflow-auto table-container"
      style={columnSizeVars as React.CSSProperties}
    >
      <table className="w-full text-xs border-collapse table-fixed [contain:layout_style]">
        <thead className="sticky top-0 z-10">
          <tr className="bg-muted border-b-2 border-border">
            {isColVisible("event") && (
              <th
                className="text-left px-3 h-8 font-semibold text-[11px] text-foreground sticky left-0 bg-muted relative whitespace-nowrap"
                style={{ width: "calc(var(--col-event-size) * 1px)" }}
              >
                Event
                <ResizeHandle col="event" />
              </th>
            )}
            {isColVisible("ko") && (
              <th
                className="text-center px-2 h-8 font-semibold text-[11px] text-foreground relative whitespace-nowrap"
                style={{ width: "calc(var(--col-ko-size) * 1px)" }}
              >
                <button
                  type="button"
                  className={sortButtonClass}
                  onClick={() => prefs.cycleTableSort("ko")}
                  title="Kickoff time — click to sort"
                >
                  KO
                  <SortIndicator col="ko" />
                </button>
                <ResizeHandle col="ko" />
              </th>
            )}
            {isColVisible("market") && (
              <th
                className="text-center px-2 h-8 font-semibold text-[11px] text-foreground relative whitespace-nowrap"
                style={{ width: "calc(var(--col-market-size) * 1px)" }}
              >
                Market
                <ResizeHandle col="market" />
              </th>
            )}
            {isColVisible("outcome") && (
              <th
                className="text-center px-2 h-8 font-semibold text-[11px] text-foreground relative whitespace-nowrap"
                style={{ width: "calc(var(--col-outcome-size) * 1px)" }}
              >
                Outcome
                <ResizeHandle col="outcome" />
              </th>
            )}
            {isColVisible("ev") && (
              <th
                className="text-center px-2 h-8 font-semibold text-[11px] text-foreground bg-cyan-900/20 whitespace-nowrap"
                style={{ width: "calc(var(--col-ev-size) * 1px)" }}
              >
                <button
                  type="button"
                  className={sortButtonClass}
                  onClick={() => prefs.cycleTableSort("ev")}
                  title="Expected value — click to sort"
                >
                  EV %
                  <SortIndicator col="ev" />
                </button>
              </th>
            )}
            {isColVisible("kelly") && (
              <th
                className="text-center px-2 h-8 font-semibold text-[11px] text-foreground whitespace-nowrap"
                style={{ width: "calc(var(--col-kelly-size) * 1px)" }}
              >
                <button
                  type="button"
                  className={sortButtonClass}
                  onClick={() => prefs.cycleTableSort("kelly")}
                  title="Kelly fraction — click to sort"
                >
                  Kelly
                  <SortIndicator col="kelly" />
                </button>
              </th>
            )}
            {visibleProviders.map((providerId) => (
              <th
                key={providerId}
                className={`text-center px-2 h-8 font-semibold text-[11px] whitespace-nowrap ${getProviderColorClasses(providerId)}`}
                style={{ width: "calc(var(--col-provider-size) * 1px)" }}
              >
                {getProviderShortName(providerId)}
              </th>
            ))}

            <th
              className="text-center px-2 h-8 font-semibold text-[11px] text-foreground whitespace-nowrap"
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
                  isEngineWarming ? (
                    <div className="flex flex-col items-center gap-2 py-4">
                      <Loader2 className="size-5 animate-spin text-primary" />
                      <span className="text-sm font-medium text-foreground">
                        Syncing provider data
                      </span>
                      <span className="text-xs text-muted-foreground/70">
                        Pulling fixtures from all sportsbooks and matching across providers — this usually takes 1–2 minutes after a cold start.
                      </span>
                    </div>
                  ) : searchTerm ? (
                    `No events found matching "${searchTerm}". Try a different search term.`
                  ) : prefs.hasActiveFilters ? (
                    "No value bets match your current filters. Try widening the EV range, odds range, or resetting filters."
                  ) : (
                    "No matched events found. Odds will appear as the engine processes data."
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
              {virtualItems.length > 0 && (
                <tr style={{ height: virtualItems[0].start }} />
              )}
              {virtualItems.map((virtualRow) => {
                const row = rows[virtualRow.index];
                const index = virtualRow.index;
                const eventInfo = eventProvidersMap.get(row.eventId);
                return (
                  <SpreadsheetRow
                    key={row.rowId}
                    row={row}
                    visibleProviders={visibleProviders}
                    isLastInFamily={
                      index === rows.length - 1 ||
                      rows[index + 1]?.familyId !== row.familyId ||
                      rows[index + 1]?.eventId !== row.eventId
                    }

                    eventProviders={eventInfo?.providers || []}
                    providerEventIds={eventInfo?.providerEventIds || {}}
                    copyingRawData={copyingRawData}
                    onSelectValueBet={setSelectedValueBet}
                    onCopyRawData={handleCopyRawData}
                    onHide={handleHideFamily}
                    onMovementClick={handleMovementClick}
                    liveScore={eventInfo?.liveScore}
                    suspended={eventInfo?.suspended}
                  />
                );
              })}
              {virtualItems.length > 0 && (
                <tr
                  style={{
                    height:
                      totalSize -
                      (virtualItems[virtualItems.length - 1]?.end ?? 0),
                  }}
                />
              )}
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
        {toolbar}
        {tableContent}

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

      {selectedValueBet &&
        (() => {
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

      <MovementDetailModal
        open={movementModal !== null}
        onOpenChange={(open) => { if (!open) setMovementModal(null); }}
        data={movementModal?.data ?? null}
        eventLabel={movementModal?.eventLabel ?? ""}
        marketLabel={movementModal?.marketLabel ?? ""}
      />
    </>
  );
}
