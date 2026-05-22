"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format, parseISO } from "date-fns";
import {
  Calendar,
  Check,
  ChevronDown,
  Clock,
  Loader2,
  RotateCcw,
  Save,
  Search,
  Trash2,
  X,
  Gavel,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RefreshButton } from "@/components/ui/refresh-button";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { BetsStatsResponse } from "@/lib/bets-history/api-client";
import { prettySettledBy } from "@/lib/bets-history/resettle";
import {
  DATE_PRESETS,
  type DatePresetKey,
} from "@/lib/bets-history/date-presets";
import { SettlementStatusChip } from "./SettlementMonitor";
import type { Outcome, ValueBetRow } from "@/lib/bets-history/types";
import type { ListFilters } from "@/lib/bets-history/api-client";
import { type RerunChoice } from "./AiSettleDialog";
import { AiModelMenuItems } from "@/components/shared/AiModelMenuItems";
import { useBettingSettings } from "@/hooks/use-betting-settings";
import { cn } from "@/lib/utils";
import { OddsRangeDropdown } from "@/components/filters/OddsRangeDropdown";
import { MarketsFilter } from "@/components/filters/MarketsFilter";
import { ProvidersFilter } from "@/components/filters/ProvidersFilter";
import { EvRangeFilter } from "@/components/filters/EvRangeFilter";

// ============================================
// Option data
// ============================================

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

const DATE_PRESET_GROUPS: {
  title: string;
  keys: DatePresetKey[];
}[] = [
  {
    title: "Hours",
    keys: ["last1h", "last3h", "last6h", "last12h", "last24h", "last48h"],
  },
  {
    title: "Days",
    keys: [
      "today",
      "yesterday",
      "thisWeek",
      "lastWeek",
      "last3d",
      "last7d",
      "last15d",
    ],
  },
  {
    title: "Months",
    keys: ["thisMonth", "last30d", "last60d", "last90d", "all"],
  },
];

function getPresetLabel(key: DatePresetKey) {
  return DATE_PRESETS.find((preset) => preset.key === key)?.label ?? key;
}

function getCompactPresetLabel(key: DatePresetKey) {
  const shortLabels: Partial<Record<DatePresetKey, string>> = {
    last1h: "1h",
    last3h: "3h",
    last6h: "6h",
    last12h: "12h",
    last24h: "24h",
    last48h: "48h",
    today: "Today",
    yesterday: "Yday",
    thisWeek: "Week",
    lastWeek: "Prev wk",
    last3d: "3d",
    last7d: "7d",
    last15d: "15d",
    thisMonth: "Month",
    last30d: "30d",
    last60d: "60d",
    last90d: "90d",
    all: "All",
    custom: "Custom",
  };

  return shortLabels[key] ?? getPresetLabel(key);
}

function formatDateValue(value?: string) {
  if (!value) return null;

  const date = parseISO(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);

  const isBoundaryTime =
    value.endsWith("T00:00:00.000Z") || value.endsWith("T23:59:59.000Z");

  return format(date, isBoundaryTime ? "MMM d" : "MMM d HH:mm");
}

function describeDateSelection(
  preset: DatePresetKey,
  from?: string,
  to?: string,
) {
  if (preset !== "custom") {
    return preset === "all" ? "All time" : getPresetLabel(preset);
  }

  const start = formatDateValue(from);
  const end = formatDateValue(to);

  if (start && end) return `${start} to ${end}`;
  if (start) return `From ${start}`;
  if (end) return `Until ${end}`;
  return "Custom range";
}

function describeCompactDateSelection(
  preset: DatePresetKey,
  from?: string,
  to?: string,
) {
  if (preset !== "custom") return getCompactPresetLabel(preset);

  const start = formatDateValue(from);
  const end = formatDateValue(to);

  if (start && end) return `${start} to ${end}`;
  if (start) return start;
  if (end) return end;
  return "Custom";
}

function getDateTriggerSummary({
  capturedPreset,
  kickoffPreset,
  from,
  to,
  eventFrom,
  eventTo,
}: {
  capturedPreset: DatePresetKey;
  kickoffPreset: DatePresetKey;
  from?: string;
  to?: string;
  eventFrom?: string;
  eventTo?: string;
}) {
  const capturedActive = capturedPreset !== "all" || from != null || to != null;
  const kickoffActive =
    kickoffPreset !== "all" || eventFrom != null || eventTo != null;

  if (!capturedActive && !kickoffActive) return "All";

  const capturedSummary = describeCompactDateSelection(
    capturedPreset,
    from,
    to,
  );
  const kickoffSummary = describeCompactDateSelection(
    kickoffPreset,
    eventFrom,
    eventTo,
  );

  if (capturedActive && kickoffActive) {
    return `Cap ${capturedSummary} · Kick ${kickoffSummary}`;
  }
  if (capturedActive) return `Cap ${capturedSummary}`;
  return `Kick ${kickoffSummary}`;
}

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

function DateSummaryBadge({
  value,
  active,
}: {
  value: string;
  active: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-[168px] min-w-0 items-center rounded-full border px-2 py-0.5 text-[10px] leading-none",
        active
          ? "border-primary/35 bg-primary/12 text-foreground"
          : "border-border/70 bg-muted/45 text-muted-foreground",
      )}
    >
      <span className="truncate font-medium">{value}</span>
    </span>
  );
}

// ============================================
// DatePresetPanel — tabbed preset selector
// ============================================

function DatePresetPanel({
  capturedPreset,
  kickoffPreset,
  filters,
  onApplyPreset,
  onUpdateFilters,
}: {
  capturedPreset: DatePresetKey;
  kickoffPreset: DatePresetKey;
  filters: ListFilters;
  onApplyPreset: (
    key: DatePresetKey,
    dimension: "captured" | "kickoff",
  ) => void;
  onUpdateFilters: (patch: Partial<ListFilters>) => void;
}) {
  const activePreset = (tab: "captured" | "kickoff") =>
    tab === "captured" ? capturedPreset : kickoffPreset;
  const defaultTab =
    kickoffPreset !== "all" && capturedPreset === "all"
      ? "kickoff"
      : "captured";
  const capturedSummary = describeDateSelection(
    capturedPreset,
    filters.from,
    filters.to,
  );
  const kickoffSummary = describeDateSelection(
    kickoffPreset,
    filters.eventFrom,
    filters.eventTo,
  );

  return (
    <Tabs defaultValue={defaultTab} className="w-full gap-2">
      <TabsList className="grid h-auto w-full grid-cols-2 gap-1 rounded-lg bg-muted/65 p-1">
        <TabsTrigger
          value="captured"
          className="h-auto items-center justify-between rounded-md border border-transparent px-2.5 py-1.5 text-left data-[state=active]:border-primary/25 data-[state=active]:bg-background data-[state=active]:shadow-sm"
        >
          <span className="flex items-center gap-1.5">
            <Clock className="size-3" />
            <span className="text-[11px] font-medium">Captured</span>
          </span>
          <span className="truncate text-[10px] text-muted-foreground ml-1">
            {capturedSummary}
          </span>
        </TabsTrigger>
        <TabsTrigger
          value="kickoff"
          className="h-auto items-center justify-between rounded-md border border-transparent px-2.5 py-1.5 text-left data-[state=active]:border-primary/25 data-[state=active]:bg-background data-[state=active]:shadow-sm"
        >
          <span className="flex items-center gap-1.5">
            <Calendar className="size-3" />
            <span className="text-[11px] font-medium">Kickoff</span>
          </span>
          <span className="truncate text-[10px] text-muted-foreground ml-1">
            {kickoffSummary}
          </span>
        </TabsTrigger>
      </TabsList>

      {/* Captured tab */}
      <TabsContent value="captured" className="mt-0 space-y-3 px-1">
        <PresetGrid
          activePreset={activePreset("captured")}
          onSelect={(key) => onApplyPreset(key, "captured")}
        />
        {capturedPreset === "custom" && (
          <CustomDatePickers
            label="Captured time"
            fromValue={filters.from?.slice(0, 16) ?? ""}
            toValue={filters.to?.slice(0, 16) ?? ""}
            onFromChange={(v) => onUpdateFilters({ from: v })}
            onToChange={(v) => onUpdateFilters({ to: v })}
            onClear={() => onUpdateFilters({ from: undefined, to: undefined })}
          />
        )}
      </TabsContent>

      {/* Kickoff tab */}
      <TabsContent value="kickoff" className="mt-0 space-y-3 px-1">
        <PresetGrid
          activePreset={activePreset("kickoff")}
          onSelect={(key) => onApplyPreset(key, "kickoff")}
        />
        {kickoffPreset === "custom" && (
          <CustomDatePickers
            label="Kickoff time"
            fromValue={filters.eventFrom?.slice(0, 16) ?? ""}
            toValue={filters.eventTo?.slice(0, 16) ?? ""}
            onFromChange={(v) => onUpdateFilters({ eventFrom: v })}
            onToChange={(v) => onUpdateFilters({ eventTo: v })}
            onClear={() =>
              onUpdateFilters({ eventFrom: undefined, eventTo: undefined })
            }
          />
        )}
      </TabsContent>
    </Tabs>
  );
}

/** Compact chip-row preset selector shared by both tabs. */

const PRESET_TOOLTIPS: Record<DatePresetKey, string> = {
  last1h: "Rolling window — last 60 minutes from now",
  last3h: "Rolling window — last 3 hours from now",
  last6h: "Rolling window — last 6 hours from now",
  last12h: "Rolling window — last 12 hours from now",
  last24h: "Rolling window — last 24 hours from now",
  last48h: "Rolling window — last 48 hours from now",
  today: "Calendar day — midnight to end of today",
  yesterday: "Calendar day — yesterday midnight to midnight",
  thisWeek: "Calendar week — Monday 00:00 to now",
  lastWeek: "Calendar week — previous Monday to Sunday",
  last3d: "Calendar days — 3 days including today",
  last7d: "Calendar days — 7 days including today",
  last15d: "Calendar days — 15 days including today",
  thisMonth: "Calendar month — 1st of the month to now",
  last30d: "Calendar days — 30 days including today",
  last60d: "Calendar days — 60 days including today",
  last90d: "Calendar days — 90 days including today",
  all: "No date filter — show everything",
  custom: "Pick exact start and end date + time",
};

function PresetGrid({
  activePreset,
  onSelect,
}: {
  activePreset: DatePresetKey;
  onSelect: (key: DatePresetKey) => void;
}) {
  return (
    <div className="space-y-2">
      {DATE_PRESET_GROUPS.map((group) => (
        <div key={group.title} className="space-y-1">
          <div className="px-0.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            {group.title}
          </div>
          <div className="flex flex-wrap gap-1">
            {group.keys.map((key) => {
              const selected = activePreset === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onSelect(key)}
                  aria-pressed={selected}
                  title={PRESET_TOOLTIPS[key]}
                  className={cn(
                    "inline-flex items-center rounded-lg border px-2 py-1 text-[11px] font-medium transition-all duration-150",
                    selected
                      ? "border-primary/40 bg-primary/14 text-foreground shadow-sm ring-1 ring-primary/20"
                      : "border-border/70 bg-background/70 text-muted-foreground hover:border-foreground/10 hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  {getCompactPresetLabel(key)}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={() => onSelect("custom")}
        aria-pressed={activePreset === "custom"}
        title={PRESET_TOOLTIPS.custom}
        className={cn(
          "flex w-full items-center justify-between rounded-lg border border-dashed px-2 py-1 text-left text-[11px] font-medium transition-all duration-150",
          activePreset === "custom"
            ? "border-primary/35 bg-primary/12 text-foreground shadow-sm ring-1 ring-primary/20"
            : "border-border bg-muted/35 text-muted-foreground hover:border-foreground/10 hover:bg-muted/60 hover:text-foreground",
        )}
      >
        <span>Custom date & time</span>
        <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          Pick range
        </span>
      </button>
    </div>
  );
}

/** From/to datetime inputs for the "Custom…" preset. */
function CustomDatePickers({
  label,
  fromValue,
  toValue,
  onFromChange,
  onToChange,
  onClear,
}: {
  label: string;
  fromValue: string;
  toValue: string;
  onFromChange: (v: string | undefined) => void;
  onToChange: (v: string | undefined) => void;
  onClear: () => void;
}) {
  return (
    <div className="mt-2 pt-2 border-t border-border">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
        {label}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground w-8 shrink-0">
            From
          </span>
          <Input
            type="datetime-local"
            value={fromValue}
            onChange={(e) =>
              onFromChange(
                e.target.value
                  ? new Date(e.target.value).toISOString()
                  : undefined,
              )
            }
            className="h-7 flex-1 text-[11px] px-2"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground w-8 shrink-0">
            To
          </span>
          <Input
            type="datetime-local"
            value={toValue}
            onChange={(e) =>
              onToChange(
                e.target.value
                  ? new Date(e.target.value).toISOString()
                  : undefined,
              )
            }
            className="h-7 flex-1 text-[11px] px-2"
          />
        </div>
      </div>
      {(fromValue || toValue) && (
        <div className="flex justify-end mt-1.5">
          <button
            type="button"
            onClick={onClear}
            className="text-[10px] text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================
// Props
// ============================================

type Props = {
  filters: ListFilters;
  onFiltersChange: (f: ListFilters) => void;
  /** Active date preset for captured-time filter. */
  capturedPreset: DatePresetKey;
  /** Active date preset for kickoff-time filter. */
  kickoffPreset: DatePresetKey;
  onCapturedPresetChange: (preset: DatePresetKey) => void;
  onKickoffPresetChange: (preset: DatePresetKey) => void;

  totalCount: number;
  filteredCount: number;
  selectedCount: number;

  /**
   * Server-side aggregation matching the current filters. Drives the ROI +
   * win/loss cluster. May be null briefly on first load.
   */
  stats: BetsStatsResponse | null;
  statsLoading?: boolean;

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

export function BetsHistoryToolbar({
  filters,
  onFiltersChange,
  capturedPreset,
  kickoffPreset,
  onCapturedPresetChange,
  onKickoffPresetChange,
  totalCount,
  filteredCount,
  selectedCount,
  stats,
  statsLoading,
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
  onOpenSettlementMonitor,
  onReset,
  onSaveAsDefault,
  onClearSavedDefaults,
  isAtDefaults,
  hasSavedDefaults,
}: Props) {
  const update = useCallback(
    (patch: Partial<ListFilters>) => {
      onFiltersChange({ ...filters, ...patch });
    },
    [filters, onFiltersChange],
  );

  // Live strategy values so Sim ROI tooltip names the actual sizing rule.
  const { settings: bettingSettings } = useBettingSettings();
  const kellyFraction = bettingSettings?.kellyFraction ?? 0.25;
  const kellyCapPct = bettingSettings?.kellyCapPct ?? 10;
  const kellyFractionLabel = (() => {
    if (kellyFraction >= 0.99) return "full Kelly";
    // Match the 4 presets from the strategy popover; fall back to decimal.
    if (Math.abs(kellyFraction - 0.5) < 0.01) return "½ Kelly";
    if (Math.abs(kellyFraction - 0.25) < 0.01) return "¼ Kelly";
    if (Math.abs(kellyFraction - 0.125) < 0.01) return "⅛ Kelly";
    return `${kellyFraction.toFixed(3).replace(/\.?0+$/, "")}× Kelly`;
  })();

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
      "api-football",
      "ai-search-deepseek",
      "ai-search-hf",
      "ai-search-groq",
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

  /** Apply a preset to either the captured or kickoff dimension.
   *  Non-custom presets store the preset key only — the actual from/to
   *  window is re-resolved from the key on each refetch tick in the
   *  parent (see BetsHistorySpreadsheet effectiveFilters). Baking absolute
   *  timestamps into filters here would make rolling ranges go stale. */
  const applyPreset = useCallback(
    (key: DatePresetKey, dimension: "captured" | "kickoff") => {
      if (dimension === "captured") {
        onCapturedPresetChange(key);
        if (key !== "custom") {
          update({ from: undefined, to: undefined });
        }
      } else {
        onKickoffPresetChange(key);
        if (key !== "custom") {
          update({ eventFrom: undefined, eventTo: undefined });
        }
      }
    },
    [onCapturedPresetChange, onKickoffPresetChange, update],
  );

  // Server-side roll-up over the ENTIRE filter-matched population. This
  // replaces the old per-page client metrics — those only saw the infinite-
  // scroll pages already loaded, which under-reported by an order of magnitude
  // on broad filters.
  const placedOnly = filters.placedOnly === true;
  // First load only — `useBetsStats` uses `keepPreviousData`, so once stats
  // arrive they persist through every refetch. A null `stats` therefore
  // means "no data yet at all" and we should suppress the KPI numbers
  // rather than render misleading zeros.
  const statsNotReady = !stats;
  const settledCount = stats?.settled ?? 0;
  const placedSettledCount = stats?.placedSettled ?? 0;
  const winsCount = stats?.wins ?? 0;
  const halfWinsCount = stats?.halfWins ?? 0;
  const lossesCount = stats?.losses ?? 0;
  const halfLossesCount = stats?.halfLosses ?? 0;
  const matchedCount = stats?.matched ?? totalCount;
  const winRateStr =
    settledCount > 0 ? `${(stats?.flat.winRatePct ?? 0).toFixed(0)}%` : "—";
  const flatRoi = stats?.flat.roiPct ?? 0;
  const realRoi = stats?.real.roiPct ?? 0;
  const flatRoiStr =
    settledCount > 0 ? `${flatRoi >= 0 ? "+" : ""}${flatRoi.toFixed(1)}%` : "—";
  const realRoiStr =
    placedSettledCount > 0
      ? `${realRoi >= 0 ? "+" : ""}${realRoi.toFixed(1)}%`
      : "—";

  // Hide the ROI cluster on partitions where "settled" isn't meaningful.
  // Pending / ready-to-settle / needs-review contain zero settled rows by
  // definition, so a blank "—" just wastes header space.
  const roiApplicable =
    outcomeSel !== "pending" &&
    outcomeSel !== "readyToSettle" &&
    outcomeSel !== "needsReview";

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

        {/* Placed-only pill — orthogonal to outcome tabs so users can see
            "Placed + Won", "Placed + Pending" etc. Emerald accent because
            this is the money view: what you actually booked. */}
        <div className="ml-1 pl-1 border-l border-border/60">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title={
                  placedOnly
                    ? "Showing only bets you actually placed on a provider"
                    : filters.placedOnly === false
                      ? "Showing only detected opportunities that were NOT placed"
                      : "Showing both placed and detected opportunities"
                }
                className={cn(
                  "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[11px] font-medium transition-colors",
                  placedOnly
                    ? "bg-emerald-500/15 text-emerald-200 border-emerald-500/45 shadow-[0_0_0_1px_rgba(16,185,129,0.25)]"
                    : filters.placedOnly === false
                      ? "bg-slate-500/15 text-slate-300 border-slate-500/40"
                      : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/60",
                )}
              >
                <span
                  className={cn(
                    "inline-block size-1.5 rounded-full",
                    placedOnly
                      ? "bg-emerald-400"
                      : filters.placedOnly === false
                        ? "bg-slate-400"
                        : "bg-muted-foreground/40",
                  )}
                />
                <span>
                  {placedOnly
                    ? "Placed only"
                    : filters.placedOnly === false
                      ? "Detected only"
                      : "Any origin"}
                </span>
                <ChevronDown className="size-3 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[220px]">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Bet origin
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => update({ placedOnly: undefined })}
                title="Include both placed bets and detected-only opportunities"
              >
                <span className="flex-1">Any origin</span>
                {filters.placedOnly === undefined && (
                  <Check className="size-3.5 text-primary" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => update({ placedOnly: true })}
                title="Only bets that were booked with a provider (real money)"
              >
                <span className="flex-1">Placed only</span>
                {filters.placedOnly === true && (
                  <Check className="size-3.5 text-emerald-400" />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => update({ placedOnly: false })}
                title="Only value-bets the system detected but that were never placed"
              >
                <span className="flex-1">Detected only</span>
                {filters.placedOnly === false && (
                  <Check className="size-3.5 text-slate-300" />
                )}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex-1" />

        {/* Inline KPIs — all numbers roll up server-side across the full
            filtered set, not just the paginated slice the user has scrolled
            through. Every technical term gets a plain-English tooltip. */}
        <div className="flex items-center gap-3 pr-2 text-[11px] text-muted-foreground whitespace-nowrap">
          {statsNotReady ? (
            <span className="inline-flex items-center gap-1.5 opacity-70">
              <Loader2 className="size-3 animate-spin" />
              <span>Loading stats…</span>
            </span>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <span className="font-medium text-foreground tabular-nums">
                    {filteredCount}
                  </span>
                  <span className="mx-0.5 opacity-60">/</span>
                  <span className="tabular-nums">{matchedCount}</span>{" "}
                  <span>matched</span>
                  {statsLoading && (
                    <Loader2 className="inline size-3 ml-1 animate-spin opacity-50" />
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px]">
                Rows loaded so far (left) vs. total bets matching your current
                filters (right). Scroll to load more.
              </TooltipContent>
            </Tooltip>
          )}

          {!statsNotReady && roiApplicable && (
            <>
              <span className="opacity-40">·</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <span className="text-emerald-400 tabular-nums">
                      {winsCount}W
                    </span>
                    {halfWinsCount > 0 && (
                      <span className="text-emerald-300/80 tabular-nums ml-0.5">
                        +{halfWinsCount}½
                      </span>
                    )}
                    <span className="opacity-40 mx-0.5">/</span>
                    <span className="text-rose-400 tabular-nums">
                      {lossesCount}L
                    </span>
                    {halfLossesCount > 0 && (
                      <span className="text-rose-300/80 tabular-nums ml-0.5">
                        +{halfLossesCount}½
                      </span>
                    )}
                    <span className="opacity-40"> · </span>
                    <span className="tabular-nums">{winRateStr}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[280px]">
                  Wins / losses across settled bets. The ½ suffix counts
                  quarter-line splits — half the stake won (or lost), the other
                  half was refunded. Win-rate counts half-wins as 0.5.
                </TooltipContent>
              </Tooltip>
              <span className="opacity-40">·</span>

              {/* Simulated ROI — runs the user's configured Kelly strategy
                  over every matched bet. Reshapes with kellyFraction /
                  kellyCapPct so high-edge bets weight proportionally more
                  under aggressive sizing. */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1">
                    <span className="text-muted-foreground/80">Sim ROI</span>
                    <span
                      className={cn(
                        "font-medium tabular-nums",
                        flatRoi > 0 && "text-emerald-400",
                        flatRoi < 0 && "text-rose-400",
                        flatRoi === 0 && "text-foreground",
                      )}
                    >
                      {flatRoiStr}
                    </span>
                    <span className="text-muted-foreground/60 text-[10px]">
                      over {settledCount}
                    </span>
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[320px]">
                  <b>Simulated ROI.</b> Sizing each settled bet under your
                  current strategy — <b>{kellyFractionLabel}</b>, capped at{" "}
                  <b>{kellyCapPct}%</b> of bankroll — across {settledCount}{" "}
                  bets. Computed as{" "}
                  <span className="font-mono">Σ pnl / Σ stake</span>, so
                  higher-edge bets weight proportionally more. Switch the Kelly
                  fraction in the strategy popover and this number reshapes.
                </TooltipContent>
              </Tooltip>

              {/* Real ROI — uses the actual stake/odds/pnl you booked. Shown
                  only when there are placed+settled rows in the current
                  filter set, otherwise it's noise. */}
              {placedSettledCount > 0 ? (
                <>
                  <span className="opacity-40">·</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-1">
                        <span className="text-muted-foreground/80">
                          Real ROI
                        </span>
                        <span
                          className={cn(
                            "font-medium tabular-nums",
                            realRoi > 0 && "text-emerald-400",
                            realRoi < 0 && "text-rose-400",
                            realRoi === 0 && "text-foreground",
                          )}
                        >
                          {realRoiStr}
                        </span>
                        <span className="text-muted-foreground/60 text-[10px]">
                          over {placedSettledCount} placed
                        </span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[300px]">
                      <b>Real ROI.</b> Your actual money performance on bets you
                      placed with a provider — total profit divided by total
                      stake across {placedSettledCount} settled placements.
                      Unlike Sim ROI, this respects the stake size you actually
                      used on each bet.
                    </TooltipContent>
                  </Tooltip>
                </>
              ) : null}
            </>
          )}
          {!statsNotReady && !roiApplicable && settledCount === 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-muted-foreground/70 italic">
                  ROI not shown for this tab
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-[260px]">
                Return metrics only make sense once bets are settled. Switch to
                a settled-outcome tab or {`"All"`} to see ROI.
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Refresh button */}
        <RefreshButton
          onRefresh={onRefresh}
          isRefreshing={loading}
          label="Refresh results"
        />
      </div>

      {/* ================================
          FILTER + TOOLS BAR — single row
          ================================ */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-muted/50">
        <div className="flex-1 flex items-center gap-1.5 overflow-x-auto min-w-0">
          {/* Markets */}
          <MarketsFilter
            selected={filters.marketTypes ?? []}
            onChange={(values) =>
              update({ marketTypes: values.length ? values : undefined })
            }
          />

          {/* Providers */}
          <ProvidersFilter
            selected={filters.softProviders ?? []}
            onChange={(values) =>
              update({ softProviders: values.length ? values : undefined })
            }
          />

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
          <EvRangeFilter
            min={filters.minEv}
            max={filters.maxEv}
            onChange={(min, max) => update({ minEv: min, maxEv: max })}
          />

          {/* Odds range */}
          <OddsRangeDropdown
            min={filters.oddsMin}
            max={filters.oddsMax}
            onChange={(min, max) => update({ oddsMin: min, oddsMax: max })}
          />

          {/* Date range — tabbed: Captured Time + Kickoff Time */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(BTN_BASE, "justify-between gap-2 pr-1.5")}
              >
                <span className="flex items-center gap-1.5">
                  <Calendar className="size-3 opacity-60" />
                  <span>Date</span>
                </span>
                <DateSummaryBadge
                  value={getDateTriggerSummary({
                    capturedPreset,
                    kickoffPreset,
                    from: filters.from,
                    to: filters.to,
                    eventFrom: filters.eventFrom,
                    eventTo: filters.eventTo,
                  })}
                  active={
                    capturedPreset !== "all" ||
                    kickoffPreset !== "all" ||
                    filters.from != null ||
                    filters.to != null ||
                    filters.eventFrom != null ||
                    filters.eventTo != null
                  }
                />
                <ChevronDown className="size-3 opacity-60" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-[320px] rounded-xl p-2.5"
            >
              <DatePresetPanel
                capturedPreset={capturedPreset}
                kickoffPreset={kickoffPreset}
                filters={filters}
                onApplyPreset={applyPreset}
                onUpdateFilters={update}
              />
            </PopoverContent>
          </Popover>

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
            <DropdownMenuContent align="start" className="w-[200px] p-1">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/70 px-2 py-1">
                Settle with
              </DropdownMenuLabel>
              <AiModelMenuItems
                callbacks={{
                  onSelectDefault: () => onBulkSettle({ kind: "default" }),
                  onSelectAi: (engine, model) =>
                    onBulkSettle({ kind: engine, model } as RerunChoice),
                }}
              />
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
