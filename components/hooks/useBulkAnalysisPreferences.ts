"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { useLocalStorage } from "./useLocalStorage";
import { PROVIDER_IDS, type ProviderKey } from "@/lib/providers/registry";


export type TimeFilter = "all" | "live" | "upcoming";

export type TableSortKey = "ko" | "ev" | "kelly" | "captured";
export type TableSortDir = "asc" | "desc";
export interface TableSort {
  key: TableSortKey | null;
  dir: TableSortDir;
}

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
  selectedProviders: Set<ProviderKey>;
  setSelectedProviders: (providers: Set<ProviderKey>) => void;
  toggleProvider: (providerId: ProviderKey) => void;
  selectAllProviders: () => void;
  deselectAllProviders: () => void;

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

  tableSort: TableSort;
  setTableSort: (sort: TableSort) => void;
  cycleTableSort: (key: TableSortKey) => void;

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

  isFullscreen: boolean;
  setIsFullscreen: (value: boolean) => void;
  toggleFullscreen: () => void;

  selectedRows: Set<string>;
  setSelectedRows: (rows: Set<string>) => void;
  toggleRowSelection: (rowId: string) => void;
  selectAllRows: (rowIds: string[]) => void;
  deselectAllRows: () => void;

  resetFilters: () => void;
  hasActiveFilters: boolean;

  saveCurrentAsDefault: () => void;
  clearSavedDefaults: () => void;
  hasSavedDefaults: boolean;
}


export function useBulkAnalysisPreferences(): BulkAnalysisPreferences {
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

  const [tableSort, setTableSort] = useLocalStorage<TableSort>(
    "bulk-analysis-table-sort",
    { key: "ev", dir: "desc" },
  );

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

  const [selectedMarketTypesArray, setSelectedMarketTypesArray] =
    useLocalStorage<string[]>("bulk-analysis-selected-markets", []);

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

  const [savedDefaults, setSavedDefaults] =
    useLocalStorage<SavedDefaults | null>("bulk-analysis-user-defaults", null);

  const activeDefaults = useMemo(
    () => savedDefaults ?? SYSTEM_DEFAULTS,
    [savedDefaults],
  );

  const [searchTerm, setSearchTerm] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selectedRows, setSelectedRowsState] = useState<Set<string>>(new Set());

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
    setSelectedSoftProvidersArray([]);
  }, [setSelectedSoftProvidersArray]);

  const deselectAllSoftProviders = useCallback(() => {
    setSelectedSoftProvidersArray([]);
  }, [setSelectedSoftProvidersArray]);

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev);
  }, []);

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

  const clearSavedDefaults = useCallback(() => {
    setSavedDefaults(null);
  }, [setSavedDefaults]);

  const hasSavedDefaults = savedDefaults !== null;

  return {
    selectedProviders,
    setSelectedProviders,
    toggleProvider,
    selectAllProviders,
    deselectAllProviders,

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

    tableSort,
    setTableSort,
    cycleTableSort,

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

    isFullscreen,
    setIsFullscreen,
    toggleFullscreen,

    selectedRows,
    setSelectedRows,
    toggleRowSelection,
    selectAllRows,
    deselectAllRows,

    resetFilters,
    hasActiveFilters,

    saveCurrentAsDefault,
    clearSavedDefaults,
    hasSavedDefaults,
  };
}
