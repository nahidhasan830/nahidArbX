"use client";

/**
 * AutoPlacerToolbar — filter toolbar for the auto-placer log page.
 *
 * Filters: status, gate, provider, date range, search.
 * Stats strip: placed, pending, skipped, rejected, error counts.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Clock,
  ChevronDown,
  Loader2,
  Search,
  X,
} from "lucide-react";
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
import { ProvidersFilter } from "@/components/filters/ProvidersFilter";
import { TriggerBadge } from "@/components/filters/TriggerBadge";
import {
  DATE_PRESETS,
  type DatePresetKey,
} from "@/lib/bets-history/date-presets";
import { cn } from "@/lib/utils";
import type { AutoPlacerLogStats } from "@/lib/db/repositories/auto-placer-log";

// ── Status tabs ──

type StatusFilter = "all" | "placed" | "pending" | "skipped" | "rejected" | "error";

const STATUS_TAB_COLORS: Record<StatusFilter, { active: string; dot: string }> = {
  all:      { active: "bg-zinc-800 text-zinc-100 border-zinc-600", dot: "bg-zinc-400" },
  placed:   { active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", dot: "bg-emerald-400" },
  pending:  { active: "bg-amber-500/15 text-amber-300 border-amber-500/30", dot: "bg-amber-400" },
  skipped:  { active: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30", dot: "bg-zinc-400" },
  rejected: { active: "bg-rose-500/15 text-rose-300 border-rose-500/30", dot: "bg-rose-400" },
  error:    { active: "bg-red-500/15 text-red-300 border-red-500/30", dot: "bg-red-400" },
};

const STATUS_TABS: { id: StatusFilter; label: string; title: string }[] = [
  { id: "all",      label: "All",      title: "Every auto-placer decision" },
  { id: "placed",   label: "Placed",   title: "Successfully placed bets" },
  { id: "pending",  label: "Pending",  title: "Accepted by book, awaiting confirmation" },
  { id: "skipped",  label: "Skipped",  title: "Skipped by a gate (balance, EV, ML, etc.)" },
  { id: "rejected", label: "Rejected", title: "Book rejected the bet" },
  { id: "error",    label: "Error",    title: "Transport/auth/parse errors" },
];

// ── Gate filter options ──

const GATE_OPTIONS: { value: string; label: string }[] = [
  { value: "toggle",      label: "Toggle Off" },
  { value: "adapter",     label: "No Adapter" },
  { value: "ml_score",    label: "ML Gate" },
  { value: "row_missing", label: "Row Missing" },
  { value: "inflight",    label: "In-Flight" },
  { value: "refs",        label: "Ref Resolve" },
  { value: "account",     label: "Account" },
  { value: "ev_floor",    label: "EV Floor" },
  { value: "balance",     label: "Balance" },
  { value: "market_max",  label: "Market Max" },
  { value: "stake_min",   label: "Stake Min" },
  { value: "dedup",       label: "Dedup" },
  { value: "book_reject", label: "Book Reject" },
  { value: "book_error",  label: "Book Error" },
  { value: "placed",      label: "Placed ✓" },
  { value: "pending",     label: "Pending…" },
];

// ── Date preset helpers ──

const DATE_PRESET_GROUPS: { title: string; keys: DatePresetKey[] }[] = [
  { title: "Hours", keys: ["last1h", "last3h", "last6h", "last12h", "last24h", "last48h"] },
  { title: "Days", keys: ["today", "yesterday", "thisWeek", "lastWeek", "last3d", "last7d", "last15d"] },
  { title: "Months", keys: ["thisMonth", "last30d", "last60d", "last90d", "all"] },
];

function getCompactPresetLabel(key: DatePresetKey) {
  const shortLabels: Partial<Record<DatePresetKey, string>> = {
    last1h: "1h", last3h: "3h", last6h: "6h", last12h: "12h",
    last24h: "24h", last48h: "48h", today: "Today", yesterday: "Yday",
    thisWeek: "Week", lastWeek: "Prev wk", last3d: "3d", last7d: "7d",
    last15d: "15d", thisMonth: "Month", last30d: "30d", last60d: "60d",
    last90d: "90d", all: "All", custom: "Custom",
  };
  return shortLabels[key] ?? DATE_PRESETS.find((p) => p.key === key)?.label ?? key;
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

export type LogFilters = {
  from?: string;
  to?: string;
  statuses?: string[];
  gates?: string[];
  softProviders?: string[];
  search?: string;
};

// ── Props ──

type Props = {
  filters: LogFilters;
  onFiltersChange: (f: LogFilters) => void;
  datePreset: DatePresetKey;
  onDatePresetChange: (preset: DatePresetKey) => void;
  totalCount: number;
  filteredCount: number;
  stats: AutoPlacerLogStats | null;
  statsLoading?: boolean;
  loading?: boolean;
};

// ── Component ──

export function AutoPlacerToolbar({
  filters,
  onFiltersChange,
  datePreset,
  onDatePresetChange,
  totalCount,
  filteredCount,
  stats,
  statsLoading,
  loading,
}: Props) {
  const update = useCallback(
    (patch: Partial<LogFilters>) => {
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
    if (id === "all") {
      update({ statuses: undefined });
    } else {
      update({ statuses: [id] });
    }
  };

  // ── Gate filter ──
  const selectedGates = filters.gates ?? [];
  const toggleGate = (gate: string) => {
    const current = new Set(selectedGates);
    if (current.has(gate)) current.delete(gate);
    else current.add(gate);
    update({ gates: current.size > 0 ? Array.from(current) : undefined });
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
                ? tab.id === "error"
                  ? stats.errored
                  : stats[tab.id]
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
              placeholder="Search events / reasons…"
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

          {/* Gate filter */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className={BTN_BASE}>
                Gate
                <TriggerBadge active={selectedGates.length > 0}>
                  {selectedGates.length > 0 ? selectedGates.length : "All"}
                </TriggerBadge>
                <ChevronDown className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48 max-h-80 overflow-y-auto">
              <DropdownMenuLabel className="text-[10px]">
                Filter by Gate
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {GATE_OPTIONS.map((opt) => (
                <DropdownMenuCheckboxItem
                  key={opt.value}
                  checked={selectedGates.includes(opt.value)}
                  onCheckedChange={() => toggleGate(opt.value)}
                  className="text-[11px]"
                >
                  {opt.label}
                </DropdownMenuCheckboxItem>
              ))}
              {selectedGates.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => update({ gates: undefined })}
                    className="text-[11px] text-muted-foreground"
                  >
                    Clear gates
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Provider */}
          <ProvidersFilter
            selected={filters.softProviders ?? []}
            onChange={(v) => update({ softProviders: v.length ? v : undefined })}
          />


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
                <span className="font-medium text-foreground tabular-nums">{stats.total}</span>{" "}
                decisions
              </span>

              <span className="text-border">·</span>

              <span className="shrink-0">
                <span className="text-emerald-400 font-medium tabular-nums">{stats.placed}</span>
                {" placed"}
              </span>

              {stats.pending > 0 && (
                <>
                  <span className="text-border">·</span>
                  <span className="shrink-0">
                    <span className="text-amber-400 font-medium tabular-nums">{stats.pending}</span>
                    {" pending"}
                  </span>
                </>
              )}

              <span className="text-border">·</span>

              <span className="shrink-0">
                <span className="text-zinc-400 font-medium tabular-nums">{stats.skipped}</span>
                {" skipped"}
              </span>

              {stats.rejected > 0 && (
                <>
                  <span className="text-border">·</span>
                  <span className="shrink-0">
                    <span className="text-rose-400 font-medium tabular-nums">{stats.rejected}</span>
                    {" rejected"}
                  </span>
                </>
              )}

              {stats.errored > 0 && (
                <>
                  <span className="text-border">·</span>
                  <span className="shrink-0">
                    <span className="text-red-400 font-medium tabular-nums">{stats.errored}</span>
                    {" errors"}
                  </span>
                </>
              )}

              {stats.total > 0 && (
                <>
                  <span className="text-border">·</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="shrink-0 cursor-help">
                        Success{" "}
                        <span className="font-medium text-foreground tabular-nums">
                          {((stats.placed / stats.total) * 100).toFixed(1)}%
                        </span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      Placed / Total decisions (success rate of attempted placements)
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
