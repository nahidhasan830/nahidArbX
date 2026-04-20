"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  Bookmark,
  ChevronDown,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Trash2,
  X,
  Gavel,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { computeStrategyMetrics } from "@/lib/backtest/analyze";
import { prettySettledBy } from "@/lib/backtest/resettle";
import { SettlementStatusChip } from "./SettlementMonitor";
import type { Outcome, ValueBetRow } from "@/lib/backtest/types";
import type { ListFilters } from "@/lib/backtest/api-client";
import { RERUN_OPTIONS, type RerunChoice } from "./AiSettleDialog";
import { cn } from "@/lib/utils";

// ============================================
// Option data
// ============================================

const MARKET_OPTIONS: { value: string; label: string }[] = [
  { value: "MATCH_RESULT", label: "Match Result" },
  { value: "TOTAL_GOALS", label: "Total Goals" },
  { value: "OVER_UNDER", label: "Over / Under" },
  { value: "BTTS", label: "BTTS" },
  { value: "ASIAN_HANDICAP", label: "Asian Handicap" },
  { value: "EUROPEAN_HANDICAP", label: "European Handicap" },
  { value: "DNB", label: "Draw No Bet" },
  { value: "DOUBLE_CHANCE", label: "Double Chance" },
];

const PROVIDER_OPTIONS: { value: string; label: string; short: string }[] = [
  { value: "ninewickets-exchange", label: "9W Exchange", short: "NWEx" },
  { value: "ninewickets-sportsbook", label: "9W Sportsbook", short: "NWSB" },
  { value: "betconstruct", label: "BetConstruct", short: "BC" },
];

type OutcomeFilter =
  | "all"
  | "readyToSettle"
  | "needsReview"
  | "settled"
  | Outcome;

// Colored tab styling — lifted straight from the AI-matching panel. Each
// bucket has its own accent so you can tell at a glance which partition you're
// viewing.
const OUTCOME_TAB_COLORS: Record<
  OutcomeFilter,
  { active: string; dot: string }
> = {
  all: {
    active: "bg-zinc-800 text-zinc-100 border-zinc-600",
    dot: "bg-zinc-400",
  },
  readyToSettle: {
    active: "bg-orange-500/15 text-orange-300 border-orange-500/40",
    dot: "bg-orange-400",
  },
  needsReview: {
    active: "bg-red-500/15 text-red-300 border-red-500/40",
    dot: "bg-red-400",
  },
  settled: {
    active: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
    dot: "bg-cyan-400",
  },
  pending: {
    active: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    dot: "bg-amber-400",
  },
  won: {
    active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    dot: "bg-emerald-400",
  },
  half_won: {
    active: "bg-emerald-500/10 text-emerald-400 border-emerald-500/25",
    dot: "bg-emerald-300",
  },
  lost: {
    active: "bg-rose-500/15 text-rose-300 border-rose-500/30",
    dot: "bg-rose-400",
  },
  half_lost: {
    active: "bg-rose-500/10 text-rose-400 border-rose-500/25",
    dot: "bg-rose-300",
  },
  void: {
    active: "bg-slate-500/15 text-slate-300 border-slate-500/30",
    dot: "bg-slate-400",
  },
};

const OUTCOME_TABS: {
  id: OutcomeFilter;
  label: string;
  title: string;
}[] = [
  {
    id: "all",
    label: "All",
    title: "Every value bet matching the current filters",
  },
  {
    id: "readyToSettle",
    label: "Ready to settle",
    title:
      "Pending bets whose kickoff was more than 2h15m ago — the match should be finished",
  },
  {
    id: "needsReview",
    label: "Needs review",
    title:
      "Bets the settlement pipeline tried to settle but couldn't — outcome still pending after at least one tick. These need a human to verify on Google AI Mode.",
  },
  {
    id: "pending",
    label: "Pending",
    title: "Bets that haven't been settled yet",
  },
  {
    id: "settled",
    label: "Settled",
    title:
      "Any bet with a terminal outcome — won, half-won, lost, half-lost, or void",
  },
  { id: "won", label: "Won", title: "Settled as won" },
  {
    id: "half_won",
    label: "½ Won",
    title: "Quarter-line split: half stake won, half pushed",
  },
  { id: "lost", label: "Lost", title: "Settled as lost" },
  {
    id: "half_lost",
    label: "½ Lost",
    title: "Quarter-line split: half stake lost, half pushed",
  },
  {
    id: "void",
    label: "Void",
    title: "Stake returned — voided match or handicap push",
  },
];

// ============================================
// Shared primitives
// ============================================

const CTRL_H = "h-7";
const BTN_BASE = cn(CTRL_H, "px-2 text-[11px] gap-1.5 font-normal");

function Separator() {
  return <div className="w-px h-5 bg-border shrink-0" />;
}

function TriggerBadge({
  children,
  active,
}: {
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full h-4 min-w-[18px] px-1.5 text-[10px] font-medium tabular-nums",
        active
          ? "bg-primary/20 text-primary dark:bg-primary/30"
          : "bg-secondary text-secondary-foreground dark:bg-white/10",
      )}
    >
      {children}
    </span>
  );
}

// ============================================
// Props
// ============================================

type Props = {
  filters: ListFilters;
  onFiltersChange: (f: ListFilters) => void;

  totalCount: number;
  filteredCount: number;
  selectedCount: number;

  rows: ValueBetRow[];
  loading?: boolean;
  onRefresh: () => void;

  onClearSelection: () => void;
  onSelectAllLoaded: () => void;

  onBulkSettle: (choice: RerunChoice) => void;
  settleRunning: boolean;
  /**
   * Subset of selected ids that pass the "match is over" gate. Used to
   * show a helpful count / disable the button when nothing eligible.
   */
  resettleEligibleCount: number;

  onBulkMark: (outcome: Outcome) => void;
  bulkMarkRunning: boolean;

  onAnalyze: (scope: "selected" | "all") => void;
  analyzeRunning: boolean;

  onOpenStrategies: () => void;
  onOpenSettlementMonitor: () => void;

  onReset: () => void;
  onSaveAsDefault: () => void;
  onClearSavedDefaults: () => void;
  isAtDefaults: boolean;
  hasSavedDefaults: boolean;
};

// ============================================
// Component
// ============================================

export function BacktestToolbar({
  filters,
  onFiltersChange,
  totalCount,
  filteredCount,
  selectedCount,
  rows,
  loading,
  onRefresh,
  onClearSelection,
  onSelectAllLoaded,
  onBulkSettle,
  settleRunning,
  resettleEligibleCount,
  onBulkMark,
  bulkMarkRunning,
  onAnalyze,
  analyzeRunning,
  onOpenStrategies,
  onOpenSettlementMonitor,
  onReset,
  onSaveAsDefault,
  onClearSavedDefaults,
  isAtDefaults,
  hasSavedDefaults,
}: Props) {
  const update = (patch: Partial<ListFilters>) =>
    onFiltersChange({ ...filters, ...patch });

  const hasSelection = selectedCount > 0;

  // ── Debounced search ──────────────────────────────────────────────
  const [localSearch, setLocalSearch] = useState(filters.search ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync external filter → local (e.g. after reset-to-defaults)
  useEffect(() => {
    setLocalSearch(filters.search ?? "");
  }, [filters.search]);

  const commitSearch = useCallback(
    (value: string) => {
      update({ search: value || undefined });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filters],
  );

  const handleSearchChange = useCallback(
    (value: string) => {
      setLocalSearch(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => commitSearch(value), 300);
    },
    [commitSearch],
  );

  const clearSearch = useCallback(() => {
    setLocalSearch("");
    if (debounceRef.current) clearTimeout(debounceRef.current);
    update({ search: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const marketSel = filters.marketTypes ?? [];
  const providerSel = filters.softProviders ?? [];
  const settledBySel = filters.settledBySources ?? [];

  // Populate from the rows we've loaded. Server-side enum would be cleaner
  // long-term but this covers 99% of values (the waterfall only produces
  // a handful of source ids).
  const settledByOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.settledBySource) seen.add(r.settledBySource);
    }
    // Seed with the canonical waterfall sources so the menu isn't empty
    // on a fresh / all-pending page.
    [
      "sofascore",
      "espn",
      "pinnacle-ws",
      "betconstruct",
      "football-data",
      "url-context",
      "gemini-batch",
      "manual",
    ].forEach((s) => seen.add(s));
    return Array.from(seen).sort();
  }, [rows]);
  const outcomeSel: OutcomeFilter = filters.readyToSettle
    ? "readyToSettle"
    : filters.needsReview
      ? "needsReview"
      : ((filters.outcome as OutcomeFilter | undefined) ?? "all");

  const evLabel =
    filters.minEv == null && filters.maxEv == null
      ? "All"
      : `${filters.minEv ?? "–∞"} to ${filters.maxEv ?? "+∞"}`;

  const dateLabel = (() => {
    const from = filters.from?.slice(0, 10);
    const to = filters.to?.slice(0, 10);
    if (!from && !to) return "All";
    if (from && to) return `${from} → ${to}`;
    return from ? `From ${from}` : `Until ${to}`;
  })();

  // Inline metrics
  const flat = useMemo(() => computeStrategyMetrics(rows, "flat"), [rows]);
  const kellyQ = useMemo(
    () => computeStrategyMetrics(rows, "frac-kelly-0.25"),
    [rows],
  );
  const settledCount = flat.settledBets;
  const winRate =
    settledCount > 0 ? `${(flat.winRate * 100).toFixed(0)}%` : "—";
  const roiFlat =
    settledCount > 0
      ? `${flat.roiPct >= 0 ? "+" : ""}${flat.roiPct.toFixed(1)}%`
      : "—";
  const roiKelly =
    kellyQ.settledBets > 0
      ? `${kellyQ.roiPct >= 0 ? "+" : ""}${kellyQ.roiPct.toFixed(1)}%`
      : "—";

  return (
    <TooltipProvider delayDuration={200}>
      {/* ================================
          OUTCOME TABS — primary partition
          (inspired by the AI matching panel's
           To Review / Auto-Merged / Decided row)
          ================================ */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border bg-muted/40">
        {OUTCOME_TABS.map((tab) => {
          const active = outcomeSel === tab.id;
          const palette = OUTCOME_TAB_COLORS[tab.id];
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                // Only one of readyToSettle/needsReview/outcome can be
                // active at a time — clear the other two on every switch.
                if (tab.id === "readyToSettle") {
                  update({
                    outcome: undefined,
                    readyToSettle: true,
                    needsReview: undefined,
                  });
                } else if (tab.id === "needsReview") {
                  update({
                    outcome: undefined,
                    readyToSettle: undefined,
                    needsReview: true,
                  });
                } else if (tab.id === "all") {
                  update({
                    outcome: undefined,
                    readyToSettle: undefined,
                    needsReview: undefined,
                  });
                } else {
                  update({
                    outcome: tab.id,
                    readyToSettle: undefined,
                    needsReview: undefined,
                  });
                }
              }}
              title={tab.title}
              className={cn(
                "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[11px] font-medium transition-colors",
                active
                  ? palette.active
                  : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/60",
              )}
            >
              {active && (
                <span
                  className={cn(
                    "inline-block size-1.5 rounded-full",
                    palette.dot,
                  )}
                />
              )}
              <span>{tab.label}</span>
            </button>
          );
        })}

        <div className="flex-1" />

        {/* Inline KPIs */}
        <div className="flex items-center gap-3 pr-2 text-[11px] text-muted-foreground whitespace-nowrap">
          <span>
            <span className="font-medium text-foreground tabular-nums">
              {filteredCount}
            </span>
            <span className="mx-0.5 opacity-60">/</span>
            <span className="tabular-nums">{totalCount}</span>{" "}
            <span>matched</span>
          </span>
          <span className="opacity-40">·</span>
          <span>
            <span className="text-emerald-400 tabular-nums">{flat.wins}W</span>
            {flat.halfWins > 0 && (
              <span
                className="text-emerald-300/80 tabular-nums ml-0.5"
                title="Half-wins (quarter-line splits)"
              >
                +{flat.halfWins}½
              </span>
            )}
            <span className="opacity-40 mx-0.5">/</span>
            <span className="text-rose-400 tabular-nums">{flat.losses}L</span>
            {flat.halfLosses > 0 && (
              <span
                className="text-rose-300/80 tabular-nums ml-0.5"
                title="Half-losses (quarter-line splits)"
              >
                +{flat.halfLosses}½
              </span>
            )}
            <span className="opacity-40"> · </span>
            <span className="tabular-nums">{winRate}</span>
          </span>
          <span className="opacity-40">·</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                ROI{" "}
                <span
                  className={cn(
                    "font-medium tabular-nums",
                    flat.roiPct > 0 && "text-emerald-400",
                    flat.roiPct < 0 && "text-rose-400",
                    flat.roiPct === 0 && "text-foreground",
                  )}
                >
                  {roiFlat}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Flat 1u ROI · Kelly¼ = {roiKelly} · Settled {settledCount}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Refresh button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onRefresh}
              disabled={loading}
              aria-label="Refresh"
            >
              <RefreshCw
                className={cn("size-3.5", loading && "animate-spin")}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh results</TooltipContent>
        </Tooltip>
      </div>

      {/* ================================
          FILTER + TOOLS BAR — single row
          ================================ */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-muted/50">
        <div className="flex-1 flex items-center gap-1.5 overflow-x-auto min-w-0">
          {/* Markets */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className={BTN_BASE}>
                Markets
                <TriggerBadge active={marketSel.length > 0}>
                  {marketSel.length === 0 ? "All" : marketSel.length}
                </TriggerBadge>
                <ChevronDown className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[220px]">
              <div className="flex items-center justify-between px-2 py-1.5">
                <DropdownMenuLabel className="p-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Markets
                </DropdownMenuLabel>
                {marketSel.length > 0 && (
                  <button
                    type="button"
                    onClick={() => update({ marketTypes: undefined })}
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    Clear
                  </button>
                )}
              </div>
              <DropdownMenuSeparator />
              {MARKET_OPTIONS.map((opt) => (
                <DropdownMenuCheckboxItem
                  key={opt.value}
                  checked={marketSel.includes(opt.value)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(checked) => {
                    const next = checked
                      ? [...marketSel, opt.value]
                      : marketSel.filter((v) => v !== opt.value);
                    update({ marketTypes: next.length ? next : undefined });
                  }}
                >
                  {opt.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Providers */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className={BTN_BASE}>
                Providers
                <TriggerBadge active={providerSel.length > 0}>
                  {providerSel.length === 0 ? "All" : providerSel.length}
                </TriggerBadge>
                <ChevronDown className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[200px]">
              <div className="flex items-center justify-between px-2 py-1.5">
                <DropdownMenuLabel className="p-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Soft providers
                </DropdownMenuLabel>
                {providerSel.length > 0 && (
                  <button
                    type="button"
                    onClick={() => update({ softProviders: undefined })}
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    Clear
                  </button>
                )}
              </div>
              <DropdownMenuSeparator />
              {PROVIDER_OPTIONS.map((opt) => (
                <DropdownMenuCheckboxItem
                  key={opt.value}
                  checked={providerSel.includes(opt.value)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(checked) => {
                    const next = checked
                      ? [...providerSel, opt.value]
                      : providerSel.filter((v) => v !== opt.value);
                    update({ softProviders: next.length ? next : undefined });
                  }}
                >
                  <span className="flex-1">{opt.label}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {opt.short}
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Settled by */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className={BTN_BASE}>
                Settled by
                <TriggerBadge active={settledBySel.length > 0}>
                  {settledBySel.length === 0 ? "All" : settledBySel.length}
                </TriggerBadge>
                <ChevronDown className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[200px]">
              <div className="flex items-center justify-between px-2 py-1.5">
                <DropdownMenuLabel className="p-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Settlement source
                </DropdownMenuLabel>
                {settledBySel.length > 0 && (
                  <button
                    type="button"
                    onClick={() => update({ settledBySources: undefined })}
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    Clear
                  </button>
                )}
              </div>
              <DropdownMenuSeparator />
              {settledByOptions.map((src) => (
                <DropdownMenuCheckboxItem
                  key={src}
                  checked={settledBySel.includes(src)}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(checked) => {
                    const next = checked
                      ? [...settledBySel, src]
                      : settledBySel.filter((v) => v !== src);
                    update({
                      settledBySources: next.length ? next : undefined,
                    });
                  }}
                >
                  <span className="flex-1">{prettySettledBy(src)}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {src}
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Separator />

          {/* EV range */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className={BTN_BASE}>
                EV%
                <TriggerBadge
                  active={filters.minEv != null || filters.maxEv != null}
                >
                  {evLabel}
                </TriggerBadge>
                <ChevronDown className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="p-2.5 min-w-[220px]"
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
                EV % range
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  step="0.1"
                  value={filters.minEv ?? ""}
                  onChange={(e) =>
                    update({
                      minEv: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                  placeholder="Min"
                  className="h-7 w-20 text-[11px] px-2"
                />
                <span className="text-muted-foreground text-[11px]">to</span>
                <Input
                  type="number"
                  step="0.1"
                  value={filters.maxEv ?? ""}
                  onChange={(e) =>
                    update({
                      maxEv: e.target.value
                        ? Number(e.target.value)
                        : undefined,
                    })
                  }
                  placeholder="Max"
                  className="h-7 w-20 text-[11px] px-2"
                />
                {(filters.minEv != null || filters.maxEv != null) && (
                  <button
                    type="button"
                    onClick={() =>
                      update({ minEv: undefined, maxEv: undefined })
                    }
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    Clear
                  </button>
                )}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Date range */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className={BTN_BASE}>
                Date
                <TriggerBadge
                  active={filters.from != null || filters.to != null}
                >
                  {dateLabel}
                </TriggerBadge>
                <ChevronDown className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="p-2.5 min-w-[280px]"
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
                First seen
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  type="date"
                  value={filters.from?.slice(0, 10) ?? ""}
                  onChange={(e) =>
                    update({
                      from: e.target.value
                        ? `${e.target.value}T00:00:00.000Z`
                        : undefined,
                    })
                  }
                  className="h-7 w-[120px] text-[11px] px-2"
                />
                <span className="text-muted-foreground text-[11px]">→</span>
                <Input
                  type="date"
                  value={filters.to?.slice(0, 10) ?? ""}
                  onChange={(e) =>
                    update({
                      to: e.target.value
                        ? `${e.target.value}T23:59:59.000Z`
                        : undefined,
                    })
                  }
                  className="h-7 w-[120px] text-[11px] px-2"
                />
              </div>
              {(filters.from != null || filters.to != null) && (
                <div className="flex justify-end mt-1.5">
                  <button
                    type="button"
                    onClick={() => update({ from: undefined, to: undefined })}
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    Clear
                  </button>
                </div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <Separator />

          {/* Search with leading icon — same pattern as the matching panel */}
          <div className="relative">
            <Search className="size-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              value={localSearch}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search teams or league…"
              className="w-52 h-7 pl-7 pr-7 text-[11px]"
            />
            {localSearch && (
              <button
                type="button"
                onClick={clearSearch}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                aria-label="Clear search"
              >
                <X className="size-3" />
              </button>
            )}
          </div>

          {/* Settlement monitor */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <SettlementStatusChip onClick={onOpenSettlementMonitor} />
              </div>
            </TooltipTrigger>
            <TooltipContent>
              Open the Settlement Activity Monitor — inspect recent ticks,
              pause/resume, or engage the kill switch
            </TooltipContent>
          </Tooltip>

          {/* Strategies */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={BTN_BASE}
                onClick={onOpenStrategies}
              >
                <Bookmark className="size-3.5" />
                Strategies
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Save current filters as a strategy, or load a saved one
            </TooltipContent>
          </Tooltip>

          {/* Analyze — dropdown: selected vs all.
              Disabled when the active outcome tab contains only unsettled rows
              (Pending / Ready to settle / Needs review). Analysis operates on
              settled outcomes, so pending-only views would produce empty
              metrics and a misleading "no data" verdict. */}
          {(() => {
            const pendingOnlyView =
              outcomeSel === "pending" ||
              outcomeSel === "readyToSettle" ||
              outcomeSel === "needsReview";
            const analyzeDisabled =
              analyzeRunning || totalCount === 0 || pendingOnlyView;
            const disabledReason = pendingOnlyView
              ? "Switch to a tab with settled outcomes (All, Settled, Won, Lost, …) to analyse."
              : totalCount === 0
                ? "No bets match the current filters."
                : null;
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className={BTN_BASE}
                          disabled={analyzeDisabled}
                        >
                          {analyzeRunning ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <BarChart3 className="size-3.5" />
                          )}
                          Analyze
                          <ChevronDown className="size-3 opacity-60" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-64">
                        <DropdownMenuItem
                          disabled={!hasSelection}
                          onClick={() => onAnalyze("selected")}
                        >
                          <div className="flex flex-col gap-0.5">
                            <span>Analyze selected</span>
                            <span className="text-[10px] text-muted-foreground">
                              {hasSelection
                                ? `${selectedCount} row${selectedCount === 1 ? "" : "s"} ticked`
                                : "Tick rows to enable"}
                            </span>
                          </div>
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onAnalyze("all")}>
                          <div className="flex flex-col gap-0.5">
                            <span>Analyze all matching</span>
                            <span className="text-[10px] text-muted-foreground">
                              Fetches every bet matching current filters (
                              {totalCount})
                            </span>
                          </div>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </span>
                </TooltipTrigger>
                {disabledReason && (
                  <TooltipContent side="bottom" className="max-w-[260px]">
                    {disabledReason}
                  </TooltipContent>
                )}
              </Tooltip>
            );
          })()}
        </div>

        {/* Reset + defaults (split button) — pinned to the far right */}
        <div className="flex items-center shrink-0">
          <Button
            variant={isAtDefaults ? "outline" : "default"}
            size="sm"
            onClick={onReset}
            disabled={isAtDefaults}
            className={cn(BTN_BASE, "rounded-r-none")}
          >
            <RotateCcw className="size-3.5" />
            Reset
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant={isAtDefaults ? "outline" : "default"}
                size="sm"
                className={cn(CTRL_H, "rounded-l-none border-l-0 px-1.5")}
              >
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[200px]">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Filter defaults
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onSaveAsDefault}>
                <Save className="size-3.5" />
                Save current as default
              </DropdownMenuItem>
              {hasSavedDefaults && (
                <DropdownMenuItem
                  onClick={onClearSavedDefaults}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                  Clear saved default
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* ================================
          SELECTION BAR — only when rows selected
          (blue rounded-full pill copied from the
           matching panel's selection chip)
          ================================ */}
      {hasSelection && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-primary/5">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/15 border border-blue-500/30 text-blue-300 text-[11px] font-medium">
            <span className="size-1.5 rounded-full bg-blue-400" />
            <span className="tabular-nums">{selectedCount}</span>
            selected
          </span>

          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                className={cn(BTN_BASE, "bg-primary text-primary-foreground")}
                disabled={settleRunning}
              >
                {settleRunning ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Gavel className="size-3.5" />
                )}
                Settle
                {resettleEligibleCount !== selectedCount && (
                  <TriggerBadge active={resettleEligibleCount > 0}>
                    {resettleEligibleCount}/{selectedCount}
                  </TriggerBadge>
                )}
                <ChevronDown className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[180px] p-1">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/70 px-2 py-1">
                Settle with
              </DropdownMenuLabel>
              {RERUN_OPTIONS.filter((o) => o.group === "default").map((opt) => (
                <DropdownMenuItem
                  key={opt.label}
                  onClick={() => onBulkSettle(opt.choice)}
                  disabled={settleRunning || resettleEligibleCount === 0}
                  className="cursor-pointer gap-2.5 rounded-md px-2 py-2"
                  title={opt.hint}
                >
                  <opt.icon className={cn("size-3.5 shrink-0", opt.accent)} />
                  <span className="text-[12px] font-medium">{opt.label}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator className="my-1" />
              <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/70 px-2 py-1">
                AI Models
              </DropdownMenuLabel>
              {RERUN_OPTIONS.filter((o) => o.group === "ai").map((opt) => (
                <DropdownMenuItem
                  key={opt.label}
                  onClick={() => onBulkSettle(opt.choice)}
                  disabled={settleRunning}
                  className="cursor-pointer gap-2.5 rounded-md px-2 py-2"
                  title={opt.hint}
                >
                  <opt.icon className={cn("size-3.5 shrink-0", opt.accent)} />
                  <span className="text-[12px] font-medium">{opt.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Separator />

          <Button
            variant="outline"
            size="sm"
            className={cn(
              BTN_BASE,
              "border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10",
            )}
            onClick={() => onBulkMark("won")}
            disabled={bulkMarkRunning}
          >
            Mark Won
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              BTN_BASE,
              "border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/10",
            )}
            onClick={() => onBulkMark("half_won")}
            disabled={bulkMarkRunning}
            title="Quarter-line: half stake won, other half pushed"
          >
            ½ Won
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              BTN_BASE,
              "border-rose-500/30 text-rose-300 hover:bg-rose-500/10",
            )}
            onClick={() => onBulkMark("lost")}
            disabled={bulkMarkRunning}
          >
            Mark Lost
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              BTN_BASE,
              "border-rose-500/25 text-rose-400 hover:bg-rose-500/10",
            )}
            onClick={() => onBulkMark("half_lost")}
            disabled={bulkMarkRunning}
            title="Quarter-line: half stake lost, other half pushed"
          >
            ½ Lost
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={BTN_BASE}
            onClick={() => onBulkMark("void")}
            disabled={bulkMarkRunning}
          >
            Void
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={BTN_BASE}
            onClick={() => onBulkMark("pending")}
            disabled={bulkMarkRunning}
          >
            Reset
          </Button>

          <div className="flex-1" />

          <Button
            variant="ghost"
            size="sm"
            className={BTN_BASE}
            onClick={onSelectAllLoaded}
          >
            Select all ({filteredCount})
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={BTN_BASE}
            onClick={onClearSelection}
          >
            <X className="size-3.5" />
            Clear
          </Button>
        </div>
      )}
    </TooltipProvider>
  );
}
