"use client";

/**
 * MarketDiagnosticsToolbar — health stat strip + filter row.
 *
 * Top section: glanceable health pills (matched markets, active events,
 * unmapped count, anomaly count, reversal count).
 *
 * Bottom section: type tabs (All/Unmapped/Anomalies), provider filter,
 * severity filter, search, refresh button, entry count.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Search,
  X,
  HelpCircle,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RefreshButton } from "@/components/ui/refresh-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  HealthStats,
  DiagnosticTypeFilter,
  SeverityFilter,
} from "./types";

// ============================================
// Type tab styling
// ============================================

const TYPE_TAB_COLORS: Record<
  DiagnosticTypeFilter,
  { active: string; dot: string }
> = {
  all: {
    active: "bg-zinc-800 text-zinc-100 border-zinc-600",
    dot: "bg-zinc-400",
  },
  unmapped: {
    active: "bg-amber-500/15 text-amber-300 border-amber-500/40",
    dot: "bg-amber-400",
  },
  anomaly: {
    active: "bg-red-500/15 text-red-300 border-red-500/40",
    dot: "bg-red-400",
  },
};

const TYPE_TABS: {
  id: DiagnosticTypeFilter;
  label: string;
  title: string;
}[] = [
  {
    id: "all",
    label: "All",
    title: "Every diagnostic signal — unmapped markets and anomalies combined",
  },
  {
    id: "unmapped",
    label: "Unmapped",
    title:
      "Provider markets our mapping code can't resolve to an atom. Sorted by frequency — fix the highest-hit ones first.",
  },
  {
    id: "anomaly",
    label: "Anomalies",
    title:
      "Value bets where soft-vs-sharp implied probability deviated by > 15%. Flagged but NOT blocked — investigate the mapping.",
  },
];

// ============================================
// Helpers
// ============================================

const CTRL_H = "h-7";
const BTN_BASE = cn(CTRL_H, "px-2 text-[11px] gap-1.5 font-normal");

function StatPill({
  label,
  value,
  variant = "default",
  tooltip,
}: {
  label: string;
  value: string | number;
  variant?: "default" | "success" | "warning" | "danger";
  tooltip: string;
}) {
  const variantClass = {
    default: "bg-muted/60 text-muted-foreground border-border/50",
    success: "bg-emerald-500/10 text-emerald-400 border-emerald-500/25",
    warning: "bg-amber-500/10 text-amber-400 border-amber-500/25",
    danger: "bg-red-500/10 text-red-400 border-red-500/25",
  }[variant];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] tabular-nums font-medium cursor-default transition-colors",
            variantClass,
          )}
        >
          <span className="text-[10px] uppercase tracking-wider opacity-70">
            {label}
          </span>
          <span className="font-semibold">{value}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px]">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

// ============================================
// Props
// ============================================

type Props = {
  typeFilter: DiagnosticTypeFilter;
  onTypeFilterChange: (t: DiagnosticTypeFilter) => void;
  severityFilter: SeverityFilter;
  onSeverityFilterChange: (s: SeverityFilter) => void;
  provider: string;
  onProviderChange: (p: string) => void;
  providers: string[];
  search: string;
  onSearchChange: (s: string) => void;
  health: HealthStats | null;
  healthLoading: boolean;
  totalCount: number;
  filteredCount: number;
  loading: boolean;
  onRefresh: () => void;
};

// ============================================
// Component
// ============================================

export function MarketDiagnosticsToolbar({
  typeFilter,
  onTypeFilterChange,
  severityFilter,
  onSeverityFilterChange,
  provider,
  onProviderChange,
  providers,
  search,
  onSearchChange,
  health,
  healthLoading,
  totalCount,
  filteredCount,
  loading,
  onRefresh,
}: Props) {
  // Debounced search
  const [localSearch, setLocalSearch] = useState(search);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalSearch(search);
  }, [search]);

  const commitSearch = useCallback(
    (value: string) => {
      onSearchChange(value);
    },
    [onSearchChange],
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
    onSearchChange("");
  }, [onSearchChange]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className="flex flex-col border-b border-border">
      {/* ── Row 1: Health stat pills ── */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/50 overflow-x-auto">
        {health ? (
          <>
            <StatPill
              label="Matched"
              value={health.matchedMarkets}
              variant="success"
              tooltip={`${health.matchedMarkets} atoms with 2+ providers — these are working correctly. ${health.totalOddsRecords} total odds records across ${health.totalAtoms} atoms.`}
            />
            <StatPill
              label="Events"
              value={health.activeEvents}
              variant="default"
              tooltip={`${health.activeEvents} events currently have odds in the atoms store.`}
            />
            <StatPill
              label="Unmapped"
              value={health.unmappedCount}
              variant={health.unmappedCount > 0 ? "warning" : "default"}
              tooltip={`${health.unmappedCount} distinct provider markets that our mapping code can't resolve. Sorted by occurrence — fix the highest-hit ones first.`}
            />
            <StatPill
              label="Anomalies"
              value={health.anomalyTotal}
              variant={health.anomalyTotal > 0 ? "warning" : "default"}
              tooltip={`${health.anomalyTotal} IP-deviation anomalies flagged by the value detector (> 15% deviation between soft and sharp implied probability).`}
            />
            {health.reversalCount > 0 && (
              <StatPill
                label="Reversals"
                value={health.reversalCount}
                variant="danger"
                tooltip={`${health.reversalCount} likely participant reversals (> 30% IP deviation) — home/away teams are probably swapped. These create massive fake EV and should be investigated immediately.`}
              />
            )}
          </>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            {healthLoading ? "Loading health stats…" : "No health data"}
          </span>
        )}

        <div className="ml-auto shrink-0">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] text-muted-foreground gap-1"
              >
                <HelpCircle className="size-3.5" /> Help
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-[380px] text-sm leading-relaxed space-y-2"
            >
              <p>
                <strong>Market Diagnostics</strong> surfaces every mapping issue
                in one place. Each row is either an unmapped market (a provider
                sent data we can&apos;t map) or an anomaly (odds deviation
                between soft and sharp books).
              </p>
              <p>
                <strong>Unmapped</strong> rows show how many times a market was
                seen but couldn&apos;t be mapped. Expand them to see the raw JSON
                payload and write the correct mapping code.
              </p>
              <p>
                <strong>Anomaly</strong> rows show odds mismatches. A{" "}
                <em>Participant Reversal</em> (&gt;30% IP gap) means the
                home/away teams are probably swapped — the most dangerous
                mapping error. Expand them to see a visual odds comparison.
              </p>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* ── Row 2: Type tabs + filters ── */}
      <div className="flex items-center gap-2 px-4 py-1.5 flex-wrap">
        {/* Type tabs */}
        <div className="flex items-center rounded-md border border-border bg-muted/30 p-0.5 gap-0.5">
          {TYPE_TABS.map(({ id, label, title }) => {
            const active = typeFilter === id;
            const colors = TYPE_TAB_COLORS[id];
            return (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onTypeFilterChange(id)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-[11px] font-medium transition-all duration-150 border",
                      active
                        ? colors.active
                        : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/60",
                    )}
                    aria-pressed={active}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        active ? colors.dot : "bg-muted-foreground/40",
                      )}
                    />
                    {label}
                    {id === "unmapped" && health && health.unmappedCount > 0 && (
                      <span className="text-[10px] opacity-70">
                        {health.unmappedCount}
                      </span>
                    )}
                    {id === "anomaly" && health && health.anomalyTotal > 0 && (
                      <span className="text-[10px] opacity-70">
                        {health.anomalyTotal}
                      </span>
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-[280px]">
                  {title}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        {/* Provider filter */}
        <Select value={provider} onValueChange={onProviderChange}>
          <Tooltip>
            <TooltipTrigger asChild>
              <SelectTrigger
                className={cn(BTN_BASE, "w-[140px] bg-muted/40")}
              >
                <SelectValue placeholder="All providers" />
              </SelectTrigger>
            </TooltipTrigger>
            <TooltipContent>Filter by provider</TooltipContent>
          </Tooltip>
          <SelectContent>
            <SelectItem value="all">All providers</SelectItem>
            {providers.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Severity filter — only meaningful for anomalies */}
        {typeFilter !== "unmapped" && (
          <Select
            value={severityFilter}
            onValueChange={(v) =>
              onSeverityFilterChange(v as SeverityFilter)
            }
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <SelectTrigger
                  className={cn(BTN_BASE, "w-[150px] bg-muted/40")}
                >
                  <SelectValue placeholder="All severities" />
                </SelectTrigger>
              </TooltipTrigger>
              <TooltipContent>Filter anomalies by severity</TooltipContent>
            </Tooltip>
            <SelectContent>
              <SelectItem value="all">All severities</SelectItem>
              <SelectItem value="participant_reversal">
                Reversals only
              </SelectItem>
              <SelectItem value="extreme_deviation">
                Deviations only
              </SelectItem>
            </SelectContent>
          </Select>
        )}

        {/* Search */}
        <div className="relative flex-1 min-w-[120px] max-w-[240px]">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            placeholder="Search market key / atom…"
            value={localSearch}
            onChange={(e) => handleSearchChange(e.target.value)}
            className={cn(CTRL_H, "pl-7 pr-7 text-[11px]")}
          />
          {localSearch && (
            <button
              type="button"
              onClick={clearSearch}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>

        {/* Refresh */}
        <Tooltip>
          <TooltipTrigger asChild>
            <RefreshButton
              onRefresh={onRefresh}
              isRefreshing={loading}
              className={cn(BTN_BASE, "bg-muted/40")}
            />
          </TooltipTrigger>
          <TooltipContent>Refresh (auto 30s)</TooltipContent>
        </Tooltip>

        {/* Count */}
        <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
          {filteredCount === totalCount
            ? `${totalCount} entries`
            : `${filteredCount} of ${totalCount}`}
        </span>
      </div>
    </div>
  );
}
