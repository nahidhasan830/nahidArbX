"use client";

import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
} from "react";
import { ChevronDown, X, Save, RotateCcw } from "lucide-react";
import {
  PROVIDER_IDS,
  PROVIDER_REGISTRY,
  getProviderColorClasses,
  getSoftProviders,
  type ProviderKey,
} from "@/lib/providers/registry";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { Feature } from "@/components/auth/AuthProvider";
import type { SortMode } from "@/components/hooks/useBulkAnalysisPreferences";
import { useProviderRuntimeState } from "@/components/hooks/useProviderRuntimeState";

// ============================================
// Types
// ============================================

export type TimeFilter = "all" | "live" | "upcoming";

interface SpreadsheetToolbarProps {
  // Column visibility
  hiddenColumns: Set<string>;
  onToggleColumnVisibility: (columnId: string) => void;
  onShowAllColumns: () => void;

  // Value betting toggle
  showOnlyValue: boolean;
  onToggleShowOnlyValue: () => void;
  valueRowCount: number;
  minEvPct: number;
  onMinEvPctChange: (value: number) => void;

  // Sorting (for value bets)
  sortMode: SortMode;
  onSortModeChange: (mode: SortMode) => void;
  filterHighEv: boolean;
  onToggleFilterHighEv: () => void;
  maxEvPctFilter: number;
  onMaxEvPctFilterChange: (value: number) => void;

  // Value bet filters (server-side)
  evRangeMin: number;
  evRangeMax: number;
  onEvRangeChange: (min: number, max: number) => void;
  softOddsRangeMin: number;
  softOddsRangeMax: number;
  onSoftOddsRangeChange: (min: number, max: number) => void;
  selectedSoftProviders: Set<ProviderKey>;
  onToggleSoftProvider: (providerId: ProviderKey) => void;
  onSelectAllSoftProviders: () => void;
  onDeselectAllSoftProviders: () => void;

  // Filters
  showOnlySuspicious: boolean;
  onToggleShowOnlySuspicious: () => void;
  suspiciousCount: number;
  suspiciousThresholdPct: number;
  onSuspiciousThresholdChange: (value: number) => void;
  minProviderCount: number;
  onMinProviderCountChange: (value: number) => void;
  searchTerm: string;
  onSearchChange: (value: string) => void;
  selectedMarketTypes: Set<string>;
  onToggleMarketType: (type: string) => void;
  onSelectAllMarketTypes: () => void;
  onDeselectAllMarketTypes: () => void;
  marketTypes: string[];
  timeFilter: TimeFilter;
  onTimeFilterChange: (value: TimeFilter) => void;

  // Stats
  totalRows: number;

  // Reset
  onReset: () => void;
  hasActiveFilters: boolean;

  // Custom defaults
  onSaveAsDefault: () => void;
  onClearDefaults: () => void;
  hasSavedDefaults: boolean;
}

// Use registry color classes for dynamic provider support
const getProviderBadgeClasses = getProviderColorClasses;

// ============================================
// Market Type Labels
// ============================================

const marketTypeLabels: Record<string, string> = {
  MATCH_RESULT: "Match Result (1X2)",
  TOTAL_GOALS: "Total Goals (O/U)",
  ASIAN_HANDICAP: "Asian Handicap",
  EUROPEAN_HANDICAP: "European Handicap",
  BTTS: "Both Teams to Score",
  DNB: "Draw No Bet",
  HOME_TEAM_TOTAL: "Home Team Total",
  AWAY_TEAM_TOTAL: "Away Team Total",
  CORNERS: "Corners",
  CORNERS_HANDICAP: "Corners Handicap",
  CORNERS_EUROPEAN_HANDICAP: "Corners Euro Handicap",
  HOME_CORNERS_TOTAL: "Home Corners",
  AWAY_CORNERS_TOTAL: "Away Corners",
  CARDS: "Cards",
  BOOKINGS: "Bookings",
  ODD_EVEN_GOALS: "Odd/Even Goals",
  CLEAN_SHEET: "Clean Sheet",
  WIN_TO_NIL: "Win To Nil",
  TO_SCORE: "To Score",
};

// ============================================
// Main Component
// ============================================

export function SpreadsheetToolbar({
  hiddenColumns,
  onToggleColumnVisibility,
  onShowAllColumns,
  showOnlyValue,
  onToggleShowOnlyValue,
  valueRowCount,
  minEvPct,
  onMinEvPctChange,
  sortMode,
  onSortModeChange,
  filterHighEv,
  onToggleFilterHighEv,
  maxEvPctFilter,
  onMaxEvPctFilterChange,
  evRangeMin,
  evRangeMax,
  onEvRangeChange,
  softOddsRangeMin,
  softOddsRangeMax,
  onSoftOddsRangeChange,
  selectedSoftProviders,
  onToggleSoftProvider,
  onSelectAllSoftProviders,
  onDeselectAllSoftProviders,
  showOnlySuspicious,
  onToggleShowOnlySuspicious,
  suspiciousCount,
  suspiciousThresholdPct,
  onSuspiciousThresholdChange,
  minProviderCount,
  onMinProviderCountChange,
  searchTerm,
  onSearchChange,
  selectedMarketTypes,
  onToggleMarketType,
  onSelectAllMarketTypes,
  onDeselectAllMarketTypes,
  marketTypes,
  timeFilter,
  onTimeFilterChange,
  totalRows,
  onReset,
  hasActiveFilters,
  onSaveAsDefault,
  onClearDefaults,
  hasSavedDefaults,
}: SpreadsheetToolbarProps) {
  const [marketSearch, setMarketSearch] = useState("");

  // Ref to maintain search input focus across re-renders
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Restore focus synchronously after re-render if search has content
  // This keeps cursor in search box while typing
  useLayoutEffect(() => {
    if (searchTerm && searchInputRef.current) {
      const input = searchInputRef.current;
      // Only restore focus if input is not already focused
      if (document.activeElement !== input) {
        input.focus();
        // Move cursor to end of input
        const len = input.value.length;
        input.setSelectionRange(len, len);
      }
    }
  }, [searchTerm]);

  // Server-backed provider enable/disable state. The provider checkboxes in
  // the Columns dropdown are bound to this — unchecking fully disables the
  // provider on the backend (skips fetching, odds, and AI matching).
  const providerRuntime = useProviderRuntimeState();

  // Local state for sliders to prevent table re-renders during drag
  const [localEvPct, setLocalEvPct] = useState(minEvPct);
  const [localSuspiciousThreshold, setLocalSuspiciousThreshold] = useState(
    suspiciousThresholdPct,
  );
  const [localMaxEvPctFilter, setLocalMaxEvPctFilter] =
    useState(maxEvPctFilter);
  const evDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const suspiciousDebounceRef = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const maxEvDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // Local state for value bet filter sliders (dual-handle)
  const [localEvRangeMin, setLocalEvRangeMin] = useState(evRangeMin);
  const [localEvRangeMax, setLocalEvRangeMax] = useState(evRangeMax);
  const [localSoftOddsMin, setLocalSoftOddsMin] = useState(softOddsRangeMin);
  const [localSoftOddsMax, setLocalSoftOddsMax] = useState(softOddsRangeMax);
  const evRangeDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const softOddsDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // Sync local state when external values change (e.g., reset filters)
  useEffect(() => {
    setLocalEvPct(minEvPct);
  }, [minEvPct]);

  useEffect(() => {
    setLocalSuspiciousThreshold(suspiciousThresholdPct);
  }, [suspiciousThresholdPct]);

  useEffect(() => {
    setLocalMaxEvPctFilter(maxEvPctFilter);
  }, [maxEvPctFilter]);

  useEffect(() => {
    setLocalEvRangeMin(evRangeMin);
    setLocalEvRangeMax(evRangeMax);
  }, [evRangeMin, evRangeMax]);

  useEffect(() => {
    setLocalSoftOddsMin(softOddsRangeMin);
    setLocalSoftOddsMax(softOddsRangeMax);
  }, [softOddsRangeMin, softOddsRangeMax]);

  // Debounced handler for EV % slider
  const handleEvPctChange = useCallback(
    (value: number) => {
      setLocalEvPct(value);
      if (evDebounceRef.current) clearTimeout(evDebounceRef.current);
      evDebounceRef.current = setTimeout(() => {
        onMinEvPctChange(value);
      }, 150);
    },
    [onMinEvPctChange],
  );

  // Debounced handler for suspicious threshold slider
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

  // Debounced handler for max EV filter slider
  const handleMaxEvFilterChange = useCallback(
    (value: number) => {
      setLocalMaxEvPctFilter(value);
      if (maxEvDebounceRef.current) clearTimeout(maxEvDebounceRef.current);
      maxEvDebounceRef.current = setTimeout(() => {
        onMaxEvPctFilterChange(value);
      }, 150);
    },
    [onMaxEvPctFilterChange],
  );

  // Debounced handler for EV range slider (dual-handle)
  const handleEvRangeChange = useCallback(
    (values: number[]) => {
      const [min, max] = values;
      setLocalEvRangeMin(min);
      setLocalEvRangeMax(max);
      if (evRangeDebounceRef.current) clearTimeout(evRangeDebounceRef.current);
      evRangeDebounceRef.current = setTimeout(() => {
        onEvRangeChange(min, max);
      }, 300); // Longer debounce for server-side filter
    },
    [onEvRangeChange],
  );

  // Debounced handler for soft odds range slider (dual-handle)
  const handleSoftOddsRangeChange = useCallback(
    (values: number[]) => {
      const [min, max] = values;
      setLocalSoftOddsMin(min);
      setLocalSoftOddsMax(max);
      if (softOddsDebounceRef.current)
        clearTimeout(softOddsDebounceRef.current);
      softOddsDebounceRef.current = setTimeout(() => {
        onSoftOddsRangeChange(min, max);
      }, 300); // Longer debounce for server-side filter
    },
    [onSoftOddsRangeChange],
  );

  // Compute active value filter count for badge
  const activeValueFilterCount = useMemo(() => {
    let count = 0;
    if (evRangeMin !== 0 || evRangeMax !== 100) count++;
    if (softOddsRangeMin !== 1.0 || softOddsRangeMax !== 10.0) count++;
    if (selectedSoftProviders.size > 0) count++;
    return count;
  }, [
    evRangeMin,
    evRangeMax,
    softOddsRangeMin,
    softOddsRangeMax,
    selectedSoftProviders,
  ]);

  // Get list of soft providers for the filter
  const softProvidersList = useMemo(
    () =>
      getSoftProviders().filter((providerId) =>
        providerRuntime.isEnabled(providerId),
      ),
    [providerRuntime],
  );

  // Cleanup debounce timeouts on unmount
  useEffect(() => {
    return () => {
      if (evDebounceRef.current) clearTimeout(evDebounceRef.current);
      if (suspiciousDebounceRef.current)
        clearTimeout(suspiciousDebounceRef.current);
      if (maxEvDebounceRef.current) clearTimeout(maxEvDebounceRef.current);
      if (evRangeDebounceRef.current) clearTimeout(evRangeDebounceRef.current);
      if (softOddsDebounceRef.current)
        clearTimeout(softOddsDebounceRef.current);
    };
  }, []);

  // Filtered market types based on search
  const filteredMarketTypes = useMemo(() => {
    if (!marketSearch.trim()) return marketTypes;
    const search = marketSearch.toLowerCase();
    return marketTypes.filter((type) =>
      type.toLowerCase().replace(/_/g, " ").includes(search),
    );
  }, [marketTypes, marketSearch]);

  return (
    <div className="px-4 py-2.5 border-b border-border bg-muted/50 overflow-x-auto">
      <div className="flex items-center gap-3 min-w-max">
        {/* Column Visibility Dropdown */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              Columns <ChevronDown className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56">
            <Button
              variant="ghost"
              size="xs"
              className="w-full justify-start mb-2"
              onClick={onShowAllColumns}
            >
              Show All
            </Button>
            <DropdownMenuLabel className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Data
            </DropdownMenuLabel>
            {[
              { id: "event", label: "Event" },
              { id: "competition", label: "Competition" },
              { id: "market", label: "Market" },
              { id: "outcome", label: "Outcome" },
            ].map(({ id, label }) => (
              <DropdownMenuCheckboxItem
                key={id}
                checked={!hiddenColumns.has(id)}
                onCheckedChange={() => onToggleColumnVisibility(id)}
              >
                {label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Providers
            </DropdownMenuLabel>
            {PROVIDER_IDS.map((providerId) => {
              const provider = PROVIDER_REGISTRY[providerId];
              const enabled = providerRuntime.isEnabled(providerId);
              return (
                <DropdownMenuCheckboxItem
                  key={providerId}
                  checked={enabled}
                  disabled={providerRuntime.isLoading}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(checked) => {
                    providerRuntime.toggle(providerId, checked === true);
                  }}
                >
                  <span
                    className={cn(
                      "px-1.5 py-0.5 text-xs rounded",
                      getProviderBadgeClasses(providerId),
                      !enabled && "opacity-40 line-through",
                    )}
                  >
                    {provider.shortName}
                  </span>
                  {!enabled && (
                    <span className="ml-2 text-[9px] text-red-400 uppercase tracking-wider">
                      disabled
                    </span>
                  )}
                </DropdownMenuCheckboxItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Analysis
            </DropdownMenuLabel>
            {[
              { id: "ev", label: "EV %" },
              { id: "best", label: "Best Odds" },
            ].map(({ id, label }) => (
              <DropdownMenuCheckboxItem
                key={id}
                checked={!hiddenColumns.has(id)}
                onCheckedChange={() => onToggleColumnVisibility(id)}
              >
                {label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Market Type Dropdown */}
        <Feature id="filter-market">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Markets
                <Badge
                  variant="secondary"
                  className={cn(
                    "ml-1.5 min-w-[24px]",
                    selectedMarketTypes.size === 0
                      ? "bg-secondary dark:bg-white/10"
                      : "bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300",
                  )}
                >
                  {selectedMarketTypes.size === 0
                    ? "All"
                    : selectedMarketTypes.size}
                </Badge>
                <ChevronDown className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-72">
              <div className="p-2">
                <Input
                  value={marketSearch}
                  onChange={(e) => setMarketSearch(e.target.value)}
                  placeholder="Search markets..."
                  className="h-8"
                />
              </div>
              <div className="flex gap-1 px-2 pb-2">
                <Button
                  variant={
                    selectedMarketTypes.size === 0 ? "secondary" : "ghost"
                  }
                  size="xs"
                  onClick={() => {
                    onDeselectAllMarketTypes();
                    setMarketSearch("");
                  }}
                >
                  All
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={onSelectAllMarketTypes}
                >
                  Select Visible
                </Button>
                {selectedMarketTypes.size > 0 && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-destructive"
                    onClick={onDeselectAllMarketTypes}
                  >
                    Clear
                  </Button>
                )}
              </div>
              <DropdownMenuSeparator />
              <div className="max-h-64 overflow-y-auto">
                {filteredMarketTypes.length === 0 ? (
                  <div className="text-sm text-muted-foreground py-3 text-center">
                    No markets match
                  </div>
                ) : (
                  filteredMarketTypes.map((type) => (
                    <DropdownMenuCheckboxItem
                      key={type}
                      checked={selectedMarketTypes.has(type)}
                      onCheckedChange={() => onToggleMarketType(type)}
                    >
                      {marketTypeLabels[type] || type.replace(/_/g, " ")}
                    </DropdownMenuCheckboxItem>
                  ))
                )}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </Feature>

        <div className="w-px h-6 bg-border" />

        {/* Time Filter */}
        <Feature id="filter-time">
          <ToggleGroup
            type="single"
            value={timeFilter}
            onValueChange={(value) =>
              value && onTimeFilterChange(value as TimeFilter)
            }
            size="sm"
            variant="outline"
          >
            <ToggleGroupItem value="all">All</ToggleGroupItem>
            <ToggleGroupItem value="live">Live</ToggleGroupItem>
            <ToggleGroupItem value="upcoming">Upcoming</ToggleGroupItem>
          </ToggleGroup>
        </Feature>

        <div className="w-px h-6 bg-border" />

        {/* Value Bets Only Filter (PRIMARY - shown by default for value betting mode) */}
        <Feature id="value-betting-mode">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <div
                className="flex items-center gap-2 cursor-pointer"
                title="Filter to show only value bets"
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
                <span className="text-sm font-medium">Value Only</span>
                <Badge
                  variant="secondary"
                  className={cn(
                    "tabular-nums",
                    valueRowCount > 0
                      ? "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300 animate-value-pulse"
                      : "bg-secondary dark:bg-white/10",
                  )}
                >
                  {valueRowCount}
                  {activeValueFilterCount > 0 && (
                    <span className="ml-1 text-[10px] opacity-75">
                      ({activeValueFilterCount})
                    </span>
                  )}
                </Badge>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="p-3 min-w-[280px]">
              {/* Section 1: EV % Range (dual-handle slider) */}
              <DropdownMenuLabel className="text-xs text-muted-foreground px-0 mb-2">
                EV % Range
              </DropdownMenuLabel>
              <div className="flex items-center gap-3 mb-4">
                <Slider
                  value={[localEvRangeMin, localEvRangeMax]}
                  onValueChange={handleEvRangeChange}
                  min={0}
                  max={100}
                  step={0.5}
                  className="flex-1"
                />
                <div className="text-xs tabular-nums text-right w-[70px] whitespace-nowrap">
                  {localEvRangeMin}% - {localEvRangeMax}%
                </div>
              </div>

              <DropdownMenuSeparator />

              {/* Section 2: Soft Odds Range */}
              <DropdownMenuLabel className="text-xs text-muted-foreground px-0 mb-2 pt-2">
                Soft Odds Range
              </DropdownMenuLabel>
              <div className="flex items-center gap-3 mb-4">
                <Slider
                  value={[localSoftOddsMin, localSoftOddsMax]}
                  onValueChange={handleSoftOddsRangeChange}
                  min={1.0}
                  max={10.0}
                  step={0.1}
                  className="flex-1"
                />
                <div className="text-xs tabular-nums text-right w-[70px] whitespace-nowrap">
                  {localSoftOddsMin.toFixed(1)} - {localSoftOddsMax.toFixed(1)}
                </div>
              </div>

              <DropdownMenuSeparator />

              {/* Section 3: Soft Provider Filter */}
              <DropdownMenuLabel className="text-xs text-muted-foreground px-0 mb-2 pt-2">
                Soft Providers
              </DropdownMenuLabel>
              <div className="space-y-1">
                <div className="flex gap-1 mb-2">
                  <Button
                    variant={
                      selectedSoftProviders.size === 0 ? "secondary" : "ghost"
                    }
                    size="sm"
                    className="h-6 text-xs px-2"
                    onClick={onSelectAllSoftProviders}
                  >
                    All
                  </Button>
                  {selectedSoftProviders.size > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs px-2 text-destructive"
                      onClick={onDeselectAllSoftProviders}
                    >
                      Clear
                    </Button>
                  )}
                </div>
                {softProvidersList.map((providerId) => (
                  <DropdownMenuCheckboxItem
                    key={providerId}
                    checked={
                      selectedSoftProviders.size === 0 ||
                      selectedSoftProviders.has(providerId)
                    }
                    onCheckedChange={() => onToggleSoftProvider(providerId)}
                  >
                    <span
                      className={cn(
                        "px-1.5 py-0.5 text-xs rounded",
                        getProviderBadgeClasses(providerId),
                      )}
                    >
                      {PROVIDER_REGISTRY[providerId].shortName}
                    </span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {PROVIDER_REGISTRY[providerId].displayName}
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Sort Mode Dropdown (shown alongside Value Only) */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                title="Sort value bets by priority"
              >
                Sort
                <Badge
                  variant="secondary"
                  className={cn(
                    "ml-1.5",
                    sortMode !== "default"
                      ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"
                      : "bg-secondary dark:bg-white/10",
                  )}
                >
                  {sortMode === "priority"
                    ? "Priority"
                    : sortMode === "ev"
                      ? "EV%"
                      : sortMode === "kelly"
                        ? "Kelly"
                        : sortMode === "freshness"
                          ? "Fresh"
                          : "Default"}
                </Badge>
                <ChevronDown className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[220px]">
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Sort Value Bets By
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={sortMode === "priority"}
                onCheckedChange={() => onSortModeChange("priority")}
              >
                Priority Score (Recommended)
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={sortMode === "ev"}
                onCheckedChange={() => onSortModeChange("ev")}
              >
                EV % (Highest First)
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={sortMode === "kelly"}
                onCheckedChange={() => onSortModeChange("kelly")}
              >
                Kelly Stake (Highest First)
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={sortMode === "freshness"}
                onCheckedChange={() => onSortModeChange("freshness")}
              >
                Freshness (Newest First)
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={sortMode === "default"}
                onCheckedChange={() => onSortModeChange("default")}
              >
                Default (Event Order)
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <div className="px-2 py-2">
                <div className="flex items-center gap-2 mb-2">
                  <Checkbox
                    checked={filterHighEv}
                    onCheckedChange={onToggleFilterHighEv}
                  />
                  <span className="text-sm">Filter High EV</span>
                </div>
                {filterHighEv && (
                  <div className="flex items-center gap-3">
                    <Slider
                      value={[localMaxEvPctFilter]}
                      onValueChange={([val]) => handleMaxEvFilterChange(val)}
                      min={10}
                      max={50}
                      step={1}
                      className="w-40"
                    />
                    <span className="text-sm tabular-nums w-10 text-right">
                      {localMaxEvPctFilter}%
                    </span>
                  </div>
                )}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </Feature>

        {/* Suspicious Filter with Threshold Dropdown */}
        <Feature id="filter-suspicious">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <div
                className="flex items-center gap-2 cursor-pointer"
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
                <span className="text-sm font-medium">Suspicious</span>
                <Badge
                  variant="secondary"
                  className={cn(
                    "tabular-nums",
                    suspiciousCount > 0
                      ? "bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300"
                      : "bg-secondary dark:bg-white/10",
                  )}
                >
                  {suspiciousCount} (&gt;{localSuspiciousThreshold}%)
                </Badge>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="p-3 min-w-[220px]">
              <DropdownMenuLabel className="text-xs text-muted-foreground px-0">
                Odds Difference Threshold
              </DropdownMenuLabel>
              <div className="flex items-center gap-3 pt-2">
                <Slider
                  value={[localSuspiciousThreshold]}
                  onValueChange={([val]) =>
                    handleSuspiciousThresholdChange(val)
                  }
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
        </Feature>

        <div className="w-px h-6 bg-border" />

        {/* Min Providers */}
        <Feature id="filter-provider">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Providers
                <Badge
                  variant="secondary"
                  className="ml-1.5 w-7 tabular-nums bg-secondary dark:bg-white/10"
                >
                  {minProviderCount}+
                </Badge>
                <ChevronDown className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[180px]">
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Minimum providers per market
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {[2, 3].map((count) => (
                <DropdownMenuCheckboxItem
                  key={count}
                  checked={minProviderCount === count}
                  onCheckedChange={() => onMinProviderCountChange(count)}
                >
                  {count}+ providers
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </Feature>

        <div className="w-px h-6 bg-border" />

        {/* Search */}
        <Feature id="search">
          <div className="relative">
            <Input
              ref={searchInputRef}
              value={searchTerm}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search events..."
              className="w-44 h-8 pr-7"
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
        </Feature>

        <div className="flex-1" />

        {/* Stats */}
        <span className="text-sm text-muted-foreground font-medium">
          {totalRows} rows
        </span>

        {/* Reset + Defaults */}
        <div className="flex items-center">
          <Button
            variant={hasActiveFilters ? "default" : "outline"}
            size="sm"
            onClick={onReset}
            className="rounded-r-none"
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1" />
            Reset
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant={hasActiveFilters ? "default" : "outline"}
                size="sm"
                className="rounded-l-none border-l-0 px-1.5"
              >
                <ChevronDown className="w-3.5 h-3.5" />
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

export { getProviderBadgeClasses };
