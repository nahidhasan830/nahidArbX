"use client";

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
  getProviderCommission,
  getSharpProviders,
  type ProviderKey,
} from "@/lib/providers/registry";
import {
  transformToSpreadsheetRows,
  type ValueBetEvent,
  type SpreadsheetRow as SpreadsheetRowData,
} from "@/lib/formatting/spreadsheet";
import { useBulkAnalysisPreferences } from "@/components/hooks/useBulkAnalysisPreferences";

import { useProviderRuntimeState } from "@/components/hooks/useProviderRuntimeState";
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

const SHEET_CLOCK_REFRESH_MS = 30_000;

export interface DegradedProvider {
  id: string;
  label: string;
  reason: string;
  action: string;
}

function DegradedProvidersPanel({
  providers,
  onReset,
}: {
  providers: DegradedProvider[];
  onReset?: (providerId: string) => Promise<void>;
}) {
  const [resettingIds, setResettingIds] = useState<Set<string>>(new Set());

  const handleReset = async (providerId: string) => {
    if (!onReset) return;
    setResettingIds((prev) => new Set(prev).add(providerId));
    try {
      await onReset(providerId);
    } finally {
      setResettingIds((prev) => {
        const next = new Set(prev);
        next.delete(providerId);
        return next;
      });
    }
  };

  const handleResetAll = async () => {
    if (!onReset) return;
    for (const p of providers) {
      await handleReset(p.id);
    }
  };

  return (
    <div className="flex flex-col items-center gap-3 py-4 max-w-lg mx-auto">
      <span className="text-sm font-medium text-red-400">
        Provider connectivity issues — no cross-provider odds available
      </span>
      <div className="w-full space-y-2">
        {providers.map((p) => (
          <div
            key={p.id}
            className="flex flex-col gap-0.5 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-left"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-red-400">
                {p.label}
                <span className="ml-1.5 text-[10px] font-normal text-red-400/60">
                  circuit breaker open
                </span>
              </span>
              {onReset && (
                <button
                  onClick={() => handleReset(p.id)}
                  disabled={resettingIds.has(p.id)}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors disabled:opacity-50"
                >
                  {resettingIds.has(p.id) ? (
                    <Loader2 className="w-3 h-3 animate-spin inline" />
                  ) : (
                    "Reset"
                  )}
                </button>
              )}
            </div>
            <span className="text-[11px] text-muted-foreground">
              {p.reason}
            </span>
            <span className="text-[11px] text-muted-foreground/70">
              → {p.action}
            </span>
          </div>
        ))}
      </div>
      {onReset && providers.length > 1 && (
        <button
          onClick={handleResetAll}
          disabled={resettingIds.size > 0}
          className="text-xs px-3 py-1 rounded-md bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors border border-red-500/20 disabled:opacity-50"
        >
          Reset All Circuit Breakers
        </button>
      )}
      <span className="text-xs text-muted-foreground/60">
        Events exist from Pinnacle only — value detection requires at least 2
        providers with odds.
      </span>
    </div>
  );
}

interface ValueBetSpreadsheetProps {
  events: ValueBetEvent[];
  isLoading?: boolean;
  isEngineWarming?: boolean;
  degradedProviders?: DegradedProvider[];
  onResetCircuitBreaker?: (providerId: string) => Promise<void>;
  onRefreshComplete?: () => void;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  totalCount?: number;
  totalValueBetCount?: number;
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
  timeScope: string;
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
  degradedProviders = [],
  onResetCircuitBreaker,
  onRefreshComplete: _onRefreshComplete,
  hasNextPage = false,
  isFetchingNextPage = false,
  onLoadMore,
  totalCount,
  totalValueBetCount,
  searchTerm: controlledSearchTerm,
  onSearchChange: controlledOnSearchChange,
}: ValueBetSpreadsheetProps) {
  const prefs = useBulkAnalysisPreferences();
  const providerRuntime = useProviderRuntimeState();

  const [selectedValueBet, setSelectedValueBet] =
    useState<SelectedValueBet | null>(null);

  const [movementModal, setMovementModal] = useState<{
    data: Record<string, OddsMovementData>;
    eventLabel: string;
    marketLabel: string;
    marketType?: string;
    timeScope?: string;
    familyLine?: number;
    selection?: string;
    features: number[] | null;
  } | null>(null);

  const handleMovementClick = useCallback(
    (
      oddsRow: SpreadsheetRowData["odds"],
      context: {
        eventLabel: string;
        marketLabel: string;
        valueBetDetails?: SpreadsheetRowData["valueBetDetails"];
        startTime?: string;
        marketType?: string;
        timeScope?: string;
        line?: number;
        selection?: string;
        providerCount?: number;
      },
    ) => {
      const data: Record<string, OddsMovementData> = {};
      for (const [providerKey, od] of Object.entries(oddsRow)) {
        if (od?.movement) {
          data[providerKey] = {
            provider: providerKey,
            openingOdds: od.movement.openingOdds,
            peakOdds: od.movement.peakOdds,
            troughOdds: od.movement.troughOdds,
            totalTicks: od.movement.totalTicks,
            sparkline: od.movement.sparkline,
          };
        }
      }

      let features: number[] | null = null;
      const vbd = context.valueBetDetails;
      if (vbd) {
        const sharpId = getSharpProviders()[0];
        const sharpMov = sharpId ? oddsRow[sharpId]?.movement : undefined;
        const softMov = vbd.softProvider
          ? oddsRow[vbd.softProvider]?.movement
          : undefined;

        let tickVelocity = 0;
        if (softMov && softMov.sparkline.length >= 2) {
          const first = softMov.sparkline[0];
          const last = softMov.sparkline[softMov.sparkline.length - 1];
          const spanMs = last[0] - first[0];
          if (spanMs > 0)
            tickVelocity = (softMov.sparkline.length / spanMs) * 60_000;
        }

        let timeToKickoffMin = 0;
        if (context.startTime) {
          timeToKickoffMin = Math.round(
            (new Date(context.startTime).getTime() - Date.now()) / 60_000,
          );
        }

        const MT_ORD: Record<string, number> = {
          MATCH_RESULT: 0,
          TOTAL_GOALS: 1,
          ASIAN_HANDICAP: 2,
          EUROPEAN_HANDICAP: 3,
          BTTS: 4,
          DNB: 5,
          DOUBLE_CHANCE: 6,
          HOME_TEAM_TOTAL: 7,
          AWAY_TEAM_TOTAL: 8,
          CORNERS: 9,
          CORNERS_HANDICAP: 10,
          CORNERS_EUROPEAN_HANDICAP: 11,
          HOME_CORNERS_TOTAL: 12,
          AWAY_CORNERS_TOTAL: 13,
          BOOKINGS: 14,
          BOOKINGS_HANDICAP: 15,
          ODD_EVEN_GOALS: 16,
          CLEAN_SHEET: 17,
          WIN_TO_NIL: 18,
          TO_SCORE: 19,
        };
        const marketTypeEncoded = MT_ORD[context.marketType ?? ""] ?? 0;

        let isAsianLine = 0;
        if (context.line != null) {
          const line = context.line;
          if ((line * 4) % 1 === 0 && line % 0.5 !== 0) isAsianLine = 1;
        }

        const dir = (d?: "up" | "down" | "stable") =>
          d === "up" ? 1 : d === "down" ? -1 : 0;

        const commission = getProviderCommission(vbd.softProvider);
        const adjustedSoftOdds =
          commission > 0
            ? 1 + (vbd.softOdds - 1) * (1 - commission / 100)
            : vbd.softOdds;

        const featureValues: [string, number][] = [
          ["ev_pct", vbd.evPct],
          ["sharp_true_prob", vbd.trueProb],
          ["soft_odds", vbd.softOdds],
          ["adjusted_soft_odds", adjustedSoftOdds],
          ["implied_prob_gap", vbd.trueProb - 1 / vbd.softOdds],
          ["tick_count", sharpMov?.totalTicks ?? 0],
          ["time_to_kickoff_min", timeToKickoffMin],
          ["movement_pct_sharp", sharpMov?.changePct ?? 0],
          ["movement_pct_soft", softMov?.changePct ?? 0],
          ["steam_move_sharp", sharpMov?.steamMove ? 1 : 0],
          ["steam_move_soft", softMov?.steamMove ? 1 : 0],
          ["sharp_direction", dir(sharpMov?.direction)],
          ["soft_direction", dir(softMov?.direction)],
          ["convergence_rate", 0],
          ["tick_velocity", tickVelocity],
          [
            "provider_count",
            context.providerCount ?? Object.keys(oddsRow).length,
          ],
          ["opening_sharp_odds", sharpMov?.openingOdds ?? 0],
          ["market_type_encoded", marketTypeEncoded],
          ["is_asian_line", isAsianLine],
          ["kelly_fraction_raw", vbd.kellyFraction],
          ["vig_pct", vbd.familyOdds?.vigPct ?? 0],
          ["competition_tier", 1],
          ["hours_since_line_opened", 0],
          [
            "sharp_soft_spread",
            Number.isFinite(vbd.softOdds - 1 / vbd.trueProb)
              ? vbd.softOdds - 1 / vbd.trueProb
              : 0,
          ],
          [
            "num_markets_same_event",
            Math.max(1, context.providerCount ?? Object.keys(oddsRow).length),
          ],
        ];

        features = featureValues.map(([, v]) => {
          const safe = Number.isFinite(v) ? v : 0;
          return Math.round(safe * 10000) / 10000;
        });
      }

      setMovementModal({
        data,
        eventLabel: context.eventLabel,
        marketLabel: context.marketLabel,
        marketType: context.marketType,
        timeScope: context.timeScope,
        familyLine: context.line,
        selection: context.selection,
        features,
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

  const deferredFilters = useDeferredValue({
    selectedProviders: effectiveSelectedProviders,
    searchTerm,
    selectedMarketTypes: prefs.selectedMarketTypes,
    timeFilter: prefs.timeFilter,
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
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(
      () => setNowMs(Date.now()),
      SHEET_CLOCK_REFRESH_MS,
    );
    return () => window.clearInterval(id);
  }, []);

  const handleHideFamily = useCallback((eventId: string, familyId: string) => {
    setHiddenFamilies((prev) => new Set(prev).add(`${eventId}|${familyId}`));
  }, []);

  const handleRestoreAllHidden = useCallback(() => {
    setHiddenFamilies(new Set());
  }, []);

  const { columnSizeVars, handleResizeStart } = useSpreadsheetColumnWidths(
    DEFAULT_COLUMN_WIDTHS,
  );

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
          toast.error("❌ Couldn't fetch raw data", {
            description: data.error || "Unknown error",
          });
          return;
        }

        const data = await res.json();
        await navigator.clipboard.writeText(
          JSON.stringify(data.rawResponse, null, 2),
        );
        toast.success("📋 Copied", {
          description: `${getProviderShortName(provider)} raw response`,
        });
      } catch (err) {
        clearTimeout(timeoutId);
        if (err instanceof Error && err.name === "AbortError") {
          toast.error("⏳ Copy timed out", {
            description: "Request took longer than 10s",
          });
        } else {
          toast.error("❌ Couldn't copy", {
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

  const allRows = useMemo(
    () => transformToSpreadsheetRows(events, transformFilters),
    [events, transformFilters],
  );

  const rows = useMemo(() => {
    let filtered = allRows;

    if (hiddenFamilies.size > 0) {
      filtered = filtered.filter(
        (row) => !hiddenFamilies.has(`${row.eventId}|${row.familyId}`),
      );
    }

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
  }, [allRows, hiddenFamilies, prefs.tableSort]);

  const valueRowCount = useMemo(() => {
    const unique = new Set<string>();
    for (const row of rows) {
      if (row.hasValue) unique.add(`${row.eventId}|${row.familyId}`);
    }
    return unique.size;
  }, [rows]);

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
                timeScope: matchingRow.timeScope,
                atomOdds: detailsChanged ? matchingRow.odds : prev.atomOdds,
                providerEventIds: nextProviderEventIds ?? prev.providerEventIds,
                liveScore: nextLiveScore,
              }
            : null,
        );
      }
    }
  }, [allRows, eventProvidersMap, selectedValueBet]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => 30,
    overscan: 15,
  });

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

  useEffect(() => {
    if (!onLoadMore || !hasNextPage || isFetchingNextPage) return;
    if (events.length > 0 && rows.length < 10) {
      onLoadMore();
    }
  }, [events.length, rows.length, hasNextPage, isFetchingNextPage, onLoadMore]);

  const isColVisible = (_col: string) => true;

  const visibleColCount = 6 + visibleProviders.length + 1;

  const ResizeHandle = ({ col }: { col: string }) => (
    <div
      className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-blue-500 active:bg-blue-600"
      onMouseDown={(e) => handleResizeStart(col, e)}
    />
  );

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
      valueRowCount={totalValueBetCount ?? valueRowCount}
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
      searchTerm={searchTerm}
      onSearchChange={onSearchChange}
      totalRows={rows.length}
      onReset={() => {
        prefs.resetFilters();
        onSearchChange("");
      }}
      hasActiveFilters={prefs.hasActiveFilters || searchTerm.length > 0}
      onSaveAsDefault={() => {
        prefs.saveCurrentAsDefault();
        toast.success("💾 Filters saved", {
          description: "This view will load by default next time",
        });
      }}
      onClearDefaults={() => {
        prefs.clearSavedDefaults();
        prefs.resetFilters();
        onSearchChange("");
        toast.info("🧹 Defaults cleared", {
          description: "Reset to system defaults",
        });
      }}
      hasSavedDefaults={prefs.hasSavedDefaults}
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
                        Pulling fixtures from all sportsbooks and matching
                        across providers — this usually takes 4–5 minutes after
                        a cold start.
                      </span>
                    </div>
                  ) : searchTerm ? (
                    `No events found matching "${searchTerm}". Try a different search term.`
                  ) : prefs.hasActiveFilters ? (
                    "No value bets match your current filters. Try widening the EV range, odds range, or resetting filters."
                  ) : (
                    "No matched events found. Odds will appear as the engine processes data."
                  )
                ) : degradedProviders.length > 0 ? (
                  <DegradedProvidersPanel
                    providers={degradedProviders}
                    onReset={onResetCircuitBreaker}
                  />
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
                    nowMs={nowMs}
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
                timeScope: selectedValueBet.timeScope,
                eventStartTime: selectedValueBet.startTime,
                competition: selectedValueBet.competition,
              }}
            />
          );
        })()}

      <MovementDetailModal
        open={movementModal !== null}
        onOpenChange={(open) => {
          if (!open) setMovementModal(null);
        }}
        data={movementModal?.data ?? null}
        eventLabel={movementModal?.eventLabel ?? ""}
        marketLabel={movementModal?.marketLabel ?? ""}
        marketType={movementModal?.marketType}
        timeScope={movementModal?.timeScope}
        familyLine={movementModal?.familyLine}
        selection={movementModal?.selection}
        features={movementModal?.features}
      />
    </>
  );
}
