"use client";

import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
} from "react";
import { ChevronDown, X, Save, RotateCcw } from "lucide-react";
import { OddsRangeDropdown } from "@/components/filters/OddsRangeDropdown";
import { MarketsFilter } from "@/components/filters/MarketsFilter";
import { ProvidersFilter } from "@/components/filters/ProvidersFilter";
import { EvRangeFilter } from "@/components/filters/EvRangeFilter";
import { TriggerBadge } from "@/components/filters/TriggerBadge";
import { StrategyPickerPill } from "@/components/optimizer/StrategyPickerPill";
import type { ProviderKey } from "@/lib/providers/registry";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

// ── Sizing ────────────────────────────────────────────────────────────────────
const CTRL_H = "h-7";
const BTN_BASE = cn(CTRL_H, "px-2 text-[11px] gap-1.5 font-normal");

function Separator() {
  return <div className="w-px h-5 bg-border shrink-0" />;
}

// ── Types ─────────────────────────────────────────────────────────────────────
export type TimeFilter = "all" | "live" | "upcoming";

export interface SpreadsheetToolbarProps {
  // Value Only toggle
  showOnlyValue: boolean;
  onToggleShowOnlyValue: () => void;
  valueRowCount: number;

  // Strategy-shared filters — identical semantics to BetsHistoryToolbar
  selectedMarketTypes: Set<string>;
  onMarketsChange: (markets: string[]) => void;

  selectedSoftProviders: Set<ProviderKey>;
  onSoftProvidersChange: (providers: string[]) => void;

  evRangeMin: number; // 0 = no constraint
  evRangeMax: number; // 100 = no constraint
  onEvRangeChange: (min: number, max: number) => void;

  softOddsRangeMin: number; // 1.0 = no constraint
  softOddsRangeMax: number; // 10.0 = no constraint
  onSoftOddsRangeChange: (min: number, max: number) => void;

  // Value-bets-specific filters
  timeFilter: TimeFilter;
  onTimeFilterChange: (value: TimeFilter) => void;

  showOnlySuspicious: boolean;
  onToggleShowOnlySuspicious: () => void;
  suspiciousCount: number;
  suspiciousThresholdPct: number;
  onSuspiciousThresholdChange: (value: number) => void;

  searchTerm: string;
  onSearchChange: (value: string) => void;

  // Stats + actions
  totalRows: number;
  onReset: () => void;
  hasActiveFilters: boolean;
  onSaveAsDefault: () => void;
  onClearDefaults: () => void;
  hasSavedDefaults: boolean;

  /**
   * Strategies whose filter values populate the toolbar as a template.
   * Empty = no template applied. The picker drops its "applied" badge once
   * `strategyTemplateModified` is true (toolbar diverged from template).
   */
  appliedStrategyIds: string[];
  onAppliedStrategiesChange: (ids: string[]) => void;
  strategyTemplateModified: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────
export function SpreadsheetToolbar({
  showOnlyValue,
  onToggleShowOnlyValue,
  valueRowCount,
  selectedMarketTypes,
  onMarketsChange,
  selectedSoftProviders,
  onSoftProvidersChange,
  evRangeMin,
  evRangeMax,
  onEvRangeChange,
  softOddsRangeMin,
  softOddsRangeMax,
  onSoftOddsRangeChange,
  timeFilter,
  onTimeFilterChange,
  showOnlySuspicious,
  onToggleShowOnlySuspicious,
  suspiciousCount,
  suspiciousThresholdPct,
  onSuspiciousThresholdChange,
  searchTerm,
  onSearchChange,
  totalRows,
  onReset,
  hasActiveFilters,
  onSaveAsDefault,
  onClearDefaults,
  hasSavedDefaults,
  appliedStrategyIds,
  onAppliedStrategiesChange,
  strategyTemplateModified,
}: SpreadsheetToolbarProps) {
  // Main search input — keep focus across re-renders
  const searchInputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (searchTerm && searchInputRef.current) {
      const input = searchInputRef.current;
      if (document.activeElement !== input) {
        input.focus();
        const len = input.value.length;
        input.setSelectionRange(len, len);
      }
    }
  }, [searchTerm]);

  // Suspicious threshold debounce
  const [localSuspiciousThreshold, setLocalSuspiciousThreshold] = useState(
    suspiciousThresholdPct,
  );
  const suspiciousDebounceRef = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);

  useEffect(() => {
    setLocalSuspiciousThreshold(suspiciousThresholdPct);
  }, [suspiciousThresholdPct]);

  const handleSuspiciousThresholdChange = useCallback(
    (value: number) => {
      setLocalSuspiciousThreshold(value);
      if (suspiciousDebounceRef.current)
        clearTimeout(suspiciousDebounceRef.current);
      suspiciousDebounceRef.current = setTimeout(() => {
        onSuspiciousThresholdChange(value);
      }, 150);
    },
    [onSuspiciousThresholdChange],
  );

  useEffect(() => {
    return () => {
      if (suspiciousDebounceRef.current)
        clearTimeout(suspiciousDebounceRef.current);
    };
  }, []);

  // Prefs store 0/100 as "no constraint"; shared EvRangeFilter uses undefined
  const evMin = evRangeMin === 0 ? undefined : evRangeMin;
  const evMax = evRangeMax === 100 ? undefined : evRangeMax;

  return (
    <div className="px-3 py-1.5 border-b border-border bg-muted/50 overflow-x-auto">
      <div className="flex items-center gap-1.5 min-w-max">
        {/* Strategy template — populates toolbar from a saved /lab/optimisation strategy */}
        <StrategyPickerPill
          appliedStrategyIds={appliedStrategyIds}
          onApply={onAppliedStrategiesChange}
          isModified={strategyTemplateModified}
        />
        <Separator />

        {/* ── Strategy-shared filters (same as BetsHistoryToolbar) ── */}
        <MarketsFilter
          selected={Array.from(selectedMarketTypes)}
          onChange={onMarketsChange}
        />

        <ProvidersFilter
          selected={Array.from(selectedSoftProviders)}
          onChange={onSoftProvidersChange}
        />

        <EvRangeFilter
          min={evMin}
          max={evMax}
          onChange={(min, max) => onEvRangeChange(min ?? 0, max ?? 100)}
        />

        <OddsRangeDropdown
          min={softOddsRangeMin === 1.0 ? undefined : softOddsRangeMin}
          max={softOddsRangeMax === 10.0 ? undefined : softOddsRangeMax}
          onChange={(min, max) =>
            onSoftOddsRangeChange(min ?? 1.0, max ?? 10.0)
          }
        />

        <Separator />

        {/* ── Value-bets-specific filters ── */}

        {/* Time filter */}
        <ToggleGroup
          type="single"
          value={timeFilter}
          onValueChange={(value) =>
            value && onTimeFilterChange(value as TimeFilter)
          }
          size="sm"
          variant="outline"
          className="[&>*]:h-7 [&>*]:px-2 [&>*]:text-[11px]"
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="live">Live</ToggleGroupItem>
          <ToggleGroupItem value="upcoming">Upcoming</ToggleGroupItem>
        </ToggleGroup>

        {/* Value Only toggle */}
        <div
          role="button"
          tabIndex={0}
          onClick={onToggleShowOnlyValue}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleShowOnlyValue();
            }
          }}
          className="flex items-center gap-1.5 h-7 px-1 rounded-sm hover:bg-accent/50 transition-colors cursor-pointer select-none"
          title="Show only value bets (positive EV)"
        >
          <div
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <Checkbox
              checked={showOnlyValue}
              onCheckedChange={onToggleShowOnlyValue}
            />
          </div>
          <span className="text-[11px] font-medium">Value Only</span>
          <span
            className={cn(
              "inline-flex items-center justify-center rounded-full h-4 min-w-[18px] px-1.5 text-[10px] font-medium tabular-nums",
              valueRowCount > 0
                ? "bg-cyan-500/20 text-cyan-400 animate-pulse"
                : "bg-secondary text-secondary-foreground dark:bg-white/10",
            )}
          >
            {valueRowCount}
          </span>
        </div>

        {/* Suspicious filter */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <div
              className="flex items-center gap-1.5 cursor-pointer h-7 px-1"
              title="Show markets with suspicious odds difference"
            >
              <div
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <Checkbox
                  checked={showOnlySuspicious}
                  onCheckedChange={onToggleShowOnlySuspicious}
                />
              </div>
              <span className="text-[11px] font-medium">Suspicious</span>
              <TriggerBadge active={suspiciousCount > 0}>
                {suspiciousCount} (&gt;{localSuspiciousThreshold}%)
              </TriggerBadge>
            </div>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="p-3 min-w-[220px]">
            <DropdownMenuLabel className="text-xs text-muted-foreground px-0">
              Odds Difference Threshold
            </DropdownMenuLabel>
            <div className="flex items-center gap-3 pt-2">
              <Slider
                value={[localSuspiciousThreshold]}
                onValueChange={([val]) => handleSuspiciousThresholdChange(val)}
                min={10}
                max={100}
                step={5}
                className="w-32"
              />
              <span className="text-sm tabular-nums w-10 text-right">
                {localSuspiciousThreshold}%
              </span>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        <Separator />

        {/* Search */}
        <div className="relative">
          <Input
            ref={searchInputRef}
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search events..."
            className="w-44 h-7 pr-7 text-xs"
          />
          {searchTerm && (
            <button
              onClick={() => onSearchChange("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Clear search"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <div className="flex-1" />

        {/* Row count */}
        <span className="text-[11px] text-muted-foreground font-medium tabular-nums">
          {totalRows} rows
        </span>

        {/* Reset + Defaults */}
        <div className="flex items-center">
          <Button
            variant={hasActiveFilters ? "default" : "outline"}
            size="sm"
            onClick={onReset}
            className={cn(BTN_BASE, "rounded-r-none")}
          >
            <RotateCcw className="w-3 h-3" />
            Reset
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant={hasActiveFilters ? "default" : "outline"}
                size="sm"
                className={cn(CTRL_H, "rounded-l-none border-l-0 px-1.5")}
              >
                <ChevronDown className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="text-xs">
                Filter Defaults
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onSaveAsDefault}>
                <Save className="w-3.5 h-3.5 mr-2" />
                Save Current as Default
              </DropdownMenuItem>
              {hasSavedDefaults && (
                <DropdownMenuItem
                  onClick={onClearDefaults}
                  className="text-destructive"
                >
                  <X className="w-3.5 h-3.5 mr-2" />
                  Clear Saved Defaults
                </DropdownMenuItem>
              )}
              {hasSavedDefaults && (
                <>
                  <DropdownMenuSeparator />
                  <div className="px-2 py-1.5">
                    <span className="text-[10px] text-muted-foreground">
                      Custom defaults saved. Reset restores your saved settings.
                    </span>
                  </div>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
