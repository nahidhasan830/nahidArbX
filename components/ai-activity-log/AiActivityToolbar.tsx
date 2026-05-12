"use client";

/**
 * AiActivityToolbar — filter toolbar for the AI activity log page.
 *
 * Filters: status, system, trigger, date range, search.
 * Stats strip: success/error/partial counts, total cost, avg duration.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Clock, ChevronDown, Loader2, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TriggerBadge } from "@/components/filters/TriggerBadge";
import {
  DATE_PRESETS,
  type DatePresetKey,
} from "@/lib/bets-history/date-presets";
import { cn } from "@/lib/utils";
import type { AiActivityLogStats } from "@/lib/db/repositories/ai-activity-log";

// ── Status tabs ──

type StatusFilter = "all" | "success" | "error" | "partial";

const STATUS_TAB_COLORS: Record<StatusFilter, { active: string; dot: string }> =
  {
    all: {
      active: "bg-zinc-800 text-zinc-100 border-zinc-600",
      dot: "bg-zinc-400",
    },
    success: {
      active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
      dot: "bg-emerald-400",
    },
    error: {
      active: "bg-red-500/15 text-red-300 border-red-500/30",
      dot: "bg-red-400",
    },
    partial: {
      active: "bg-amber-500/15 text-amber-300 border-amber-500/30",
      dot: "bg-amber-400",
    },
  };

const STATUS_TABS: { id: StatusFilter; label: string; title: string }[] = [
  { id: "all", label: "All", title: "Every AI operation" },
  {
    id: "success",
    label: "Success",
    title: "Successfully completed operations",
  },
  { id: "error", label: "Error", title: "Failed operations" },
  { id: "partial", label: "Partial", title: "Partially completed operations" },
];

// ── System filter options ──

const SYSTEM_OPTIONS: { value: string; label: string }[] = [
  { value: "settlement", label: "Settlement" },
  { value: "grounding", label: "Grounding" },
  { value: "entity-match", label: "Entity Match" },
  { value: "analysis", label: "Analysis" },
  { value: "propose", label: "Propose" },
];

// ── Trigger filter options ──

const TRIGGER_OPTIONS: { value: string; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "auto-scheduler", label: "Auto Scheduler" },
  { value: "playground", label: "Playground" },
  { value: "batch", label: "Batch" },
];

// ── Date preset helpers ──

const DATE_PRESET_GROUPS: { title: string; keys: DatePresetKey[] }[] = [
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
  return (
    shortLabels[key] ?? DATE_PRESETS.find((p) => p.key === key)?.label ?? key
  );
}

// ── Shared style primitives ──

const CTRL_H = "h-7";
const BTN_BASE = cn(CTRL_H, "px-2 text-[11px] gap-1.5 font-normal");

function ToolbarSep() {
  return <div className="w-px h-5 bg-border shrink-0" />;
}

// ── Date preset panel ──

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
    </div>
  );
}

// ── Filters type ──

export type AiActivityFilters = {
  from?: string;
  to?: string;
  systems?: string[];
  statuses?: string[];
  triggers?: string[];
  search?: string;
};

// ── Props ──

type Props = {
  filters: AiActivityFilters;
  onFiltersChange: (f: AiActivityFilters) => void;
  datePreset: DatePresetKey;
  onDatePresetChange: (preset: DatePresetKey) => void;
  totalCount: number;
  filteredCount: number;
  stats: AiActivityLogStats | null;
  statsLoading?: boolean;
  loading?: boolean;
};

// ── Component ──

export function AiActivityToolbar({
  filters,
  onFiltersChange,
  datePreset,
  onDatePresetChange,
  totalCount,
  filteredCount,
  stats,
  statsLoading,
  loading: _loading,
}: Props) {
  const update = useCallback(
    (patch: Partial<AiActivityFilters>) => {
      onFiltersChange({ ...filters, ...patch });
    },
    [filters, onFiltersChange],
  );

  // ── Debounced search ──
  const [localSearch, setLocalSearch] = useState(filters.search ?? "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // ── Active status ──
  const activeStatus: StatusFilter = (() => {
    const s = filters.statuses;
    if (!s || s.length === 0) return "all";
    if (s.length === 1) return s[0] as StatusFilter;
    return "all";
  })();

  const handleStatusChange = (id: StatusFilter) => {
    if (id === "all") update({ statuses: undefined });
    else update({ statuses: [id] });
  };

  // ── System filter ──
  const selectedSystems = filters.systems ?? [];
  const toggleSystem = (sys: string) => {
    const current = new Set(selectedSystems);
    if (current.has(sys)) current.delete(sys);
    else current.add(sys);
    update({ systems: current.size > 0 ? Array.from(current) : undefined });
  };

  // ── Trigger filter ──
  const selectedTriggers = filters.triggers ?? [];
  const toggleTrigger = (trig: string) => {
    const current = new Set(selectedTriggers);
    if (current.has(trig)) current.delete(trig);
    else current.add(trig);
    update({ triggers: current.size > 0 ? Array.from(current) : undefined });
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col gap-0 border-b border-border">
        {/* ── Row 1: Status tabs ── */}
        <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 overflow-x-auto">
          {STATUS_TABS.map((tab) => {
            const active = activeStatus === tab.id;
            const colors = STATUS_TAB_COLORS[tab.id];
            const count =
              stats && tab.id !== "all"
                ? stats[
                    tab.id as keyof Pick<
                      AiActivityLogStats,
                      "success" | "error" | "partial"
                    >
                  ]
                : null;
            return (
              <Tooltip key={tab.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => handleStatusChange(tab.id)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-all duration-150 whitespace-nowrap shrink-0",
                      active
                        ? colors.active
                        : "border-transparent text-muted-foreground/70 hover:text-foreground hover:bg-muted/60",
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full shrink-0",
                        active ? colors.dot : "bg-muted-foreground/30",
                      )}
                    />
                    {tab.label}
                    {count != null && count > 0 && (
                      <span className="text-[9px] opacity-60 tabular-nums">
                        {count}
                      </span>
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{tab.title}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        {/* ── Row 2: Filters ── */}
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 flex-wrap">
          {/* Search */}
          <div className="relative shrink-0">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground/50" />
            <Input
              value={localSearch}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search summary / model / error…"
              className={cn(CTRL_H, "pl-7 pr-7 w-[280px] text-[11px]")}
            />
            {localSearch && (
              <button
                type="button"
                onClick={clearSearch}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 hover:bg-muted"
              >
                <X className="size-3 text-muted-foreground" />
              </button>
            )}
          </div>

          <ToolbarSep />

          {/* Date range */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className={BTN_BASE}>
                <Clock className="size-3" />
                {getCompactPresetLabel(datePreset)}
                <ChevronDown className="size-3 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[300px] p-3">
              <PresetGrid
                activePreset={datePreset}
                onSelect={onDatePresetChange}
              />
            </PopoverContent>
          </Popover>

          <ToolbarSep />

          {/* System filter */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className={BTN_BASE}>
                System
                <TriggerBadge active={selectedSystems.length > 0}>
                  {selectedSystems.length > 0 ? selectedSystems.length : "All"}
                </TriggerBadge>
                <ChevronDown className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuLabel className="text-[10px]">
                Filter by System
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {SYSTEM_OPTIONS.map((opt) => (
                <DropdownMenuCheckboxItem
                  key={opt.value}
                  checked={selectedSystems.includes(opt.value)}
                  onCheckedChange={() => toggleSystem(opt.value)}
                  className="text-[11px]"
                >
                  {opt.label}
                </DropdownMenuCheckboxItem>
              ))}
              {selectedSystems.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => update({ systems: undefined })}
                    className="text-[11px] text-muted-foreground"
                  >
                    Clear systems
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Trigger filter */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className={BTN_BASE}>
                Trigger
                <TriggerBadge active={selectedTriggers.length > 0}>
                  {selectedTriggers.length > 0
                    ? selectedTriggers.length
                    : "All"}
                </TriggerBadge>
                <ChevronDown className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuLabel className="text-[10px]">
                Filter by Trigger
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {TRIGGER_OPTIONS.map((opt) => (
                <DropdownMenuCheckboxItem
                  key={opt.value}
                  checked={selectedTriggers.includes(opt.value)}
                  onCheckedChange={() => toggleTrigger(opt.value)}
                  className="text-[11px]"
                >
                  {opt.label}
                </DropdownMenuCheckboxItem>
              ))}
              {selectedTriggers.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => update({ triggers: undefined })}
                    className="text-[11px] text-muted-foreground"
                  >
                    Clear triggers
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* ── Row 3: Summary stats strip ── */}
        <div className="flex items-center gap-3 px-3 py-1.5 bg-muted/30 border-t border-border text-[11px] text-muted-foreground overflow-x-auto">
          {statsLoading ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="size-3 animate-spin" />
              Loading stats…
            </span>
          ) : stats ? (
            <>
              <span className="shrink-0">
                <span className="font-medium text-foreground tabular-nums">
                  {stats.total}
                </span>{" "}
                operations
              </span>
              <span className="text-border">&middot;</span>
              <span className="shrink-0">
                <span className="text-emerald-400 font-medium tabular-nums">
                  {stats.success}
                </span>{" "}
                success
              </span>
              {stats.error > 0 && (
                <>
                  <span className="text-border">&middot;</span>
                  <span className="shrink-0">
                    <span className="text-red-400 font-medium tabular-nums">
                      {stats.error}
                    </span>{" "}
                    errors
                  </span>
                </>
              )}
              {stats.partial > 0 && (
                <>
                  <span className="text-border">&middot;</span>
                  <span className="shrink-0">
                    <span className="text-amber-400 font-medium tabular-nums">
                      {stats.partial}
                    </span>{" "}
                    partial
                  </span>
                </>
              )}
              {stats.totalCostUsd > 0 && (
                <>
                  <span className="text-border">&middot;</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="shrink-0 cursor-help">
                        Cost{" "}
                        <span className="font-medium text-foreground tabular-nums">
                          ${stats.totalCostUsd.toFixed(4)}
                        </span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      Total estimated AI spend (USD)
                    </TooltipContent>
                  </Tooltip>
                </>
              )}
              {stats.avgDurationMs > 0 && (
                <>
                  <span className="text-border">&middot;</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="shrink-0 cursor-help">
                        Avg{" "}
                        <span className="font-medium text-foreground tabular-nums">
                          {stats.avgDurationMs >= 1000
                            ? `${(stats.avgDurationMs / 1000).toFixed(1)}s`
                            : `${stats.avgDurationMs}ms`}
                        </span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Average operation duration</TooltipContent>
                  </Tooltip>
                </>
              )}
              {stats.total > 0 && (
                <>
                  <span className="text-border">&middot;</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="shrink-0 cursor-help">
                        Success{" "}
                        <span className="font-medium text-foreground tabular-nums">
                          {((stats.success / stats.total) * 100).toFixed(1)}%
                        </span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      Success rate across all operations
                    </TooltipContent>
                  </Tooltip>
                </>
              )}
              <span className="ml-auto text-[10px] text-muted-foreground/50">
                {filteredCount} / {totalCount} rows
              </span>
            </>
          ) : (
            <span className="text-muted-foreground/50">No stats available</span>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
