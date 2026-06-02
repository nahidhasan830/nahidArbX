"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { useLocalStorage } from "./useLocalStorage";
import { PROVIDER_IDS, type ProviderKey } from "@/lib/providers/registry";

// ============================================
// Types
// ============================================

export type TimeFilter = "all" | "live" | "upcoming";

/** Click-to-sort columns on the value-bets table. */
export type TableSortKey = "ko" | "ev" | "kelly" | "captured";
export type TableSortDir = "asc" | "desc";
export interface TableSort {
  key: TableSortKey | null;
  dir: TableSortDir;
}

// Serializable snapshot of all filter settings (for saving as user defaults)
export interface SavedDefaults {
  selectedProviders: string[];
  showOnlyValue: boolean;
  showOnlySuspicious: boolean;
  minEvPct: number;
  timeFilter: TimeFilter;
  suspiciousThresholdPct: number;
  tableSort: TableSort;
  selectedMarketTypes: string[];
  evRangeMin: number;
  evRangeMax: number;
  softOddsRangeMin: number;
  softOddsRangeMax: number;
  selectedSoftProviders: string[];
}

// System defaults — used when user has no saved defaults
const SYSTEM_DEFAULTS: SavedDefaults = {
  selectedProviders: [...PROVIDER_IDS],
  showOnlyValue: true,
  showOnlySuspicious: false,
  minEvPct: 2.0,
  timeFilter: "all",
  suspiciousThresholdPct: 30,
  tableSort: { key: "ev", dir: "desc" },
  selectedMarketTypes: [],
  evRangeMin: 0,
  evRangeMax: 100,
  softOddsRangeMin: 1.0,
  softOddsRangeMax: 10.0,
  selectedSoftProviders: [],
};

export interface BulkAnalysisPreferences {
  // Provider selection (for which providers to include in analysis)
  selectedProviders: Set<ProviderKey>;
  setSelectedProviders: (providers: Set<ProviderKey>) => void;
  toggleProvider: (providerId: ProviderKey) => void;
  selectAllProviders: () => void;
  deselectAllProviders: () => void;

  // Filters
  showOnlyValue: boolean;
  setShowOnlyValue: (value: boolean) => void;
  showOnlySuspicious: boolean;
  setShowOnlySuspicious: (value: boolean) => void;
  minEvPct: number;
  setMinEvPct: (value: number) => void;
  searchTerm: string;
  setSearchTerm: (value: string) => void;
  selectedMarketTypes: Set<string>;
  setSelectedMarketTypes: (types: Set<string>) => void;
  toggleMarketType: (type: string) => void;
  selectAllMarketTypes: (types: string[]) => void;
  deselectAllMarketTypes: () => void;
  timeFilter: TimeFilter;
  setTimeFilter: (value: TimeFilter) => void;
  suspiciousThresholdPct: number;
  setSuspiciousThresholdPct: (value: number) => void;

  // Column-level click-to-sort
  tableSort: TableSort;
  setTableSort: (sort: TableSort) => void;
  cycleTableSort: (key: TableSortKey) => void;

  // Value bet filters (server-side)
  evRangeMin: number;
  setEvRangeMin: (value: number) => void;
  evRangeMax: number;
  setEvRangeMax: (value: number) => void;
  softOddsRangeMin: number;
  setSoftOddsRangeMin: (value: number) => void;
  softOddsRangeMax: number;
  setSoftOddsRangeMax: (value: number) => void;
  selectedSoftProviders: Set<ProviderKey>;
  setSelectedSoftProviders: (providers: Set<ProviderKey>) => void;
  toggleSoftProvider: (providerId: ProviderKey) => void;
  selectAllSoftProviders: () => void;
  deselectAllSoftProviders: () => void;

  // View state
  isFullscreen: boolean;
  setIsFullscreen: (value: boolean) => void;
  toggleFullscreen: () => void;

  // Selected rows for copy
  selectedRows: Set<string>;
  setSelectedRows: (rows: Set<string>) => void;
  toggleRowSelection: (rowId: string) => void;
  selectAllRows: (rowIds: string[]) => void;
  deselectAllRows: () => void;

  // Utility
  resetFilters: () => void;
  hasActiveFilters: boolean;

  // Custom defaults
  saveCurrentAsDefault: () => void;
  clearSavedDefaults: () => void;
  hasSavedDefaults: boolean;
}

// ============================================
// Hook
// ============================================

export function useBulkAnalysisPreferences(): BulkAnalysisPreferences {
  // Provider selection (persisted)
  const [selectedProvidersArray, setSelectedProvidersArray] = useLocalStorage<
    string[]
  >("bulk-analysis-selected-providers", [...PROVIDER_IDS]);

  useEffect(() => {
    const missing = PROVIDER_IDS.filter(
      (id) => !selectedProvidersArray.includes(id),
    );
    if (missing.length > 0) {
      setSelectedProvidersArray((prev) => [...prev, ...missing]);
    }
  }, [selectedProvidersArray, setSelectedProvidersArray]);

  // Filters (persisted)
  const [showOnlyValue, setShowOnlyValue] = useLocalStorage<boolean>(
    "bulk-analysis-value-only",
    true, // VALUE BETTING DEFAULT: show value bets by default
  );
  const [showOnlySuspicious, setShowOnlySuspicious] = useLocalStorage<boolean>(
    "bulk-analysis-suspicious-only",
    false,
  );
  const [minEvPct, setMinEvPct] = useLocalStorage<number>(
    "bulk-analysis-min-ev-pct",
    2.0,
  );
  const [timeFilter, setTimeFilter] = useLocalStorage<TimeFilter>(
    "bulk-analysis-time-filter",
    "all",
  );
  const [suspiciousThresholdPct, setSuspiciousThresholdPct] =
    useLocalStorage<number>("bulk-analysis-suspicious-threshold", 30);

  // Click-to-sort state for the spreadsheet headers. Persisted so the user's
  // chosen column sort survives reload.
  const [tableSort, setTableSort] = useLocalStorage<TableSort>(
    "bulk-analysis-table-sort",
    { key: "ev", dir: "desc" },
  );

  // Click a column to cycle through desc → asc → null.
  const cycleTableSort = useCallback(
    (key: TableSortKey) => {
      setTableSort((prev) => {
        if (prev.key !== key) return { key, dir: "desc" };
        if (prev.dir === "desc") return { key, dir: "asc" };
        return { key: null, dir: "desc" };
      });
    },
    [setTableSort],
  );

  // Selected market types (persisted) - empty array means "all"
  const [selectedMarketTypesArray, setSelectedMarketTypesArray] =
    useLocalStorage<string[]>("bulk-analysis-selected-markets", []);

  // Value bet filters (persisted, server-side)
  const [evRangeMin, setEvRangeMin] = useLocalStorage<number>(
    "bulk-analysis-ev-range-min",
    0, // Default: no minimum
  );
  const [evRangeMax, setEvRangeMax] = useLocalStorage<number>(
    "bulk-analysis-ev-range-max",
    100, // Default: no maximum (100% is effectively unlimited)
  );
  const [softOddsRangeMin, setSoftOddsRangeMin] = useLocalStorage<number>(
    "bulk-analysis-soft-odds-min",
    1.0, // Minimum possible odds
  );
  const [softOddsRangeMax, setSoftOddsRangeMax] = useLocalStorage<number>(
    "bulk-analysis-soft-odds-max",
    10.0, // Upper limit as specified
  );
  const [selectedSoftProvidersArray, setSelectedSoftProvidersArray] =
    useLocalStorage<string[]>(
      "bulk-analysis-selected-soft-providers",
      [], // Empty = all soft providers
    );

  useEffect(() => {
    if (selectedSoftProvidersArray.length === 0) return;
    const missing = PROVIDER_IDS.filter(
      (id) => !selectedSoftProvidersArray.includes(id),
    );
    if (missing.length > 0) {
      setSelectedSoftProvidersArray((prev) => [...prev, ...missing]);
    }
  }, [selectedSoftProvidersArray, setSelectedSoftProvidersArray]);

  // User-saved defaults (null = use system defaults)
  const [savedDefaults, setSavedDefaults] =
    useLocalStorage<SavedDefaults | null>("bulk-analysis-user-defaults", null);

  // Active defaults = user saved or system fallback
  const activeDefaults = useMemo(
    () => savedDefaults ?? SYSTEM_DEFAULTS,
    [savedDefaults],
  );

  // Non-persisted state
  const [searchTerm, setSearchTerm] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selectedRows, setSelectedRowsState] = useState<Set<string>>(new Set());

  // Convert arrays to Sets
  const selectedProviders = useMemo(
    () => new Set(selectedProvidersArray as ProviderKey[]),
    [selectedProvidersArray],
  );

  const selectedMarketTypes = useMemo(
    () => new Set(selectedMarketTypesArray),
    [selectedMarketTypesArray],
  );

  const selectedSoftProviders = useMemo(
    () => new Set(selectedSoftProvidersArray as ProviderKey[]),
    [selectedSoftProvidersArray],
  );

  // Provider selection actions
  const setSelectedProviders = useCallback(
    (providers: Set<ProviderKey>) => {
      setSelectedProvidersArray([...providers]);
    },
    [setSelectedProvidersArray],
  );

  const toggleProvider = useCallback(
    (providerId: ProviderKey) => {
      setSelectedProvidersArray((prev) => {
        const set = new Set(prev);
        if (set.has(providerId)) {
          set.delete(providerId);
        } else {
          set.add(providerId);
        }
        return [...set];
      });
    },
    [setSelectedProvidersArray],
  );

  const selectAllProviders = useCallback(() => {
    setSelectedProvidersArray([...PROVIDER_IDS]);
  }, [setSelectedProvidersArray]);

  const deselectAllProviders = useCallback(() => {
    setSelectedProvidersArray([]);
  }, [setSelectedProvidersArray]);

  // Market type selection actions
  const setSelectedMarketTypes = useCallback(
    (types: Set<string>) => {
      setSelectedMarketTypesArray([...types]);
    },
    [setSelectedMarketTypesArray],
  );

  const toggleMarketType = useCallback(
    (type: string) => {
      setSelectedMarketTypesArray((prev) => {
        const set = new Set(prev);
        if (set.has(type)) {
          set.delete(type);
        } else {
          set.add(type);
        }
        return [...set];
      });
    },
    [setSelectedMarketTypesArray],
  );

  const selectAllMarketTypes = useCallback(
    (types: string[]) => {
      setSelectedMarketTypesArray([...types]);
    },
    [setSelectedMarketTypesArray],
  );

  const deselectAllMarketTypes = useCallback(() => {
    setSelectedMarketTypesArray([]);
  }, [setSelectedMarketTypesArray]);

  // Soft provider selection actions
  const setSelectedSoftProviders = useCallback(
    (providers: Set<ProviderKey>) => {
      setSelectedSoftProvidersArray([...providers]);
    },
    [setSelectedSoftProvidersArray],
  );

  const toggleSoftProvider = useCallback(
    (providerId: ProviderKey) => {
      setSelectedSoftProvidersArray((prev) => {
        const set = new Set(prev);
        if (set.has(providerId)) {
          set.delete(providerId);
        } else {
          set.add(providerId);
        }
        return [...set];
      });
    },
    [setSelectedSoftProvidersArray],
  );

  const selectAllSoftProviders = useCallback(() => {
    // Empty array means "all" - this matches the pattern used for market types
    setSelectedSoftProvidersArray([]);
  }, [setSelectedSoftProvidersArray]);

  const deselectAllSoftProviders = useCallback(() => {
    setSelectedSoftProvidersArray([]);
  }, [setSelectedSoftProvidersArray]);

  // View state actions
  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev);
  }, []);

  // Row selection actions
  const setSelectedRows = useCallback((rows: Set<string>) => {
    setSelectedRowsState(rows);
  }, []);

  const toggleRowSelection = useCallback((rowId: string) => {
    setSelectedRowsState((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
  }, []);

  const selectAllRows = useCallback((rowIds: string[]) => {
    setSelectedRowsState(new Set(rowIds));
  }, []);

  const deselectAllRows = useCallback(() => {
    setSelectedRowsState(new Set());
  }, []);

  // Reset filters to user's saved defaults (or system defaults)
  const resetFilters = useCallback(() => {
    const d = activeDefaults;
    setShowOnlyValue(d.showOnlyValue);
    setShowOnlySuspicious(d.showOnlySuspicious);
    setMinEvPct(d.minEvPct);
    setSuspiciousThresholdPct(d.suspiciousThresholdPct);
    setSearchTerm("");
    setTimeFilter(d.timeFilter);
    setSelectedMarketTypesArray(d.selectedMarketTypes);
    setSelectedProvidersArray(d.selectedProviders);
    deselectAllRows();
    setTableSort(d.tableSort ?? { key: "ev", dir: "desc" });
    setEvRangeMin(d.evRangeMin);
    setEvRangeMax(d.evRangeMax);
    setSoftOddsRangeMin(d.softOddsRangeMin);
    setSoftOddsRangeMax(d.softOddsRangeMax);
    setSelectedSoftProvidersArray(d.selectedSoftProviders);
  }, [
    activeDefaults,
    setShowOnlyValue,
    setShowOnlySuspicious,
    setMinEvPct,
    setSuspiciousThresholdPct,
    setTimeFilter,
    setSelectedProvidersArray,
    setSelectedMarketTypesArray,
    setTableSort,
    setEvRangeMin,
    setEvRangeMax,
    setSoftOddsRangeMin,
    setSoftOddsRangeMax,
    setSelectedSoftProvidersArray,
    deselectAllRows,
  ]);

  const hasActiveFilters = useMemo(() => {
    const d = activeDefaults;
    const defaultProviders = new Set(d.selectedProviders);
    const defaultMarketTypes = new Set(d.selectedMarketTypes);
    const defaultSoftProviders = new Set(d.selectedSoftProviders);

    const setsEqual = (a: Set<string>, b: Set<string>) =>
      a.size === b.size && [...a].every((v) => b.has(v));

    return (
      showOnlyValue !== d.showOnlyValue ||
      showOnlySuspicious !== d.showOnlySuspicious ||
      minEvPct !== d.minEvPct ||
      suspiciousThresholdPct !== d.suspiciousThresholdPct ||
      searchTerm !== "" ||
      timeFilter !== d.timeFilter ||
      !setsEqual(selectedMarketTypes, defaultMarketTypes) ||
      !setsEqual(selectedProviders as Set<string>, defaultProviders) ||
      tableSort.key !== (d.tableSort?.key ?? "ev") ||
      tableSort.dir !== (d.tableSort?.dir ?? "desc") ||
      evRangeMin !== d.evRangeMin ||
      evRangeMax !== d.evRangeMax ||
      softOddsRangeMin !== d.softOddsRangeMin ||
      softOddsRangeMax !== d.softOddsRangeMax ||
      !setsEqual(selectedSoftProviders as Set<string>, defaultSoftProviders)
    );
  }, [
    activeDefaults,
    showOnlyValue,
    showOnlySuspicious,
    minEvPct,
    suspiciousThresholdPct,
    searchTerm,
    timeFilter,
    selectedMarketTypes,
    selectedProviders,
    tableSort,
    evRangeMin,
    evRangeMax,
    softOddsRangeMin,
    softOddsRangeMax,
    selectedSoftProviders,
  ]);

  // Save current filter state as user's default
  const saveCurrentAsDefault = useCallback(() => {
    setSavedDefaults({
      selectedProviders: selectedProvidersArray,
      showOnlyValue,
      showOnlySuspicious,
      minEvPct,
      timeFilter,
      suspiciousThresholdPct,
      tableSort,
      selectedMarketTypes: selectedMarketTypesArray,
      evRangeMin,
      evRangeMax,
      softOddsRangeMin,
      softOddsRangeMax,
      selectedSoftProviders: selectedSoftProvidersArray,
    });
  }, [
    setSavedDefaults,
    selectedProvidersArray,
    showOnlyValue,
    showOnlySuspicious,
    minEvPct,
    timeFilter,
    suspiciousThresholdPct,
    tableSort,
    selectedMarketTypesArray,
    evRangeMin,
    evRangeMax,
    softOddsRangeMin,
    softOddsRangeMax,
    selectedSoftProvidersArray,
  ]);

  // Clear saved defaults and reset to system defaults
  const clearSavedDefaults = useCallback(() => {
    setSavedDefaults(null);
  }, [setSavedDefaults]);

  const hasSavedDefaults = savedDefaults !== null;

  return {
    // Provider selection
    selectedProviders,
    setSelectedProviders,
    toggleProvider,
    selectAllProviders,
    deselectAllProviders,

    // Filters
    showOnlyValue,
    setShowOnlyValue,
    showOnlySuspicious,
    setShowOnlySuspicious,
    minEvPct,
    setMinEvPct,
    searchTerm,
    setSearchTerm,
    selectedMarketTypes,
    setSelectedMarketTypes,
    toggleMarketType,
    selectAllMarketTypes,
    deselectAllMarketTypes,
    timeFilter,
    setTimeFilter,
    suspiciousThresholdPct,
    setSuspiciousThresholdPct,

    // Column-level click-to-sort
    tableSort,
    setTableSort,
    cycleTableSort,

    // Value bet filters (server-side)
    evRangeMin,
    setEvRangeMin,
    evRangeMax,
    setEvRangeMax,
    softOddsRangeMin,
    setSoftOddsRangeMin,
    softOddsRangeMax,
    setSoftOddsRangeMax,
    selectedSoftProviders,
    setSelectedSoftProviders,
    toggleSoftProvider,
    selectAllSoftProviders,
    deselectAllSoftProviders,

    // View state
    isFullscreen,
    setIsFullscreen,
    toggleFullscreen,

    // Selected rows
    selectedRows,
    setSelectedRows,
    toggleRowSelection,
    selectAllRows,
    deselectAllRows,

    // Utility
    resetFilters,
    hasActiveFilters,

    // Custom defaults
    saveCurrentAsDefault,
    clearSavedDefaults,
    hasSavedDefaults,
  };
}
