"use client";

import { useCallback, useMemo } from "react";
import { useLocalStorage } from "@/components/hooks/useLocalStorage";
import type { ListFilters } from "./api-client";

export type SortKey =
  | "firstSeenAt"
  | "evPctMax"
  | "kellyFraction"
  | "tickCount"
  | "eventStartTime";
export type SortDir = "asc" | "desc" | "none";

export type BacktestPrefs = {
  filters: ListFilters;
  sort: { key: SortKey; dir: SortDir };
};

export type BacktestDefaults = {
  filters: ListFilters;
  sort: { key: SortKey; dir: SortDir };
};

const SYSTEM_DEFAULTS: BacktestDefaults = {
  filters: {},
  sort: { key: "firstSeenAt", dir: "desc" },
};

const PAGE_SIZE = 100;

const STORAGE_KEY_PREFS = "backtest:prefs:v2";
const STORAGE_KEY_DEFAULTS = "backtest:defaults:v2";

// Fields we persist in prefs (not offset — always start at page 0 on reload).
const sanitizeFilters = (f: ListFilters): ListFilters => {
  const { offset: _offset, limit: _limit, ...rest } = f;
  return { ...rest, limit: PAGE_SIZE, offset: 0 };
};

const arrayEq = (a?: string[], b?: string[]): boolean => {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  const sa = [...aa].sort();
  const sb = [...bb].sort();
  return sa.every((v, i) => v === sb[i]);
};

const filtersEqual = (a: ListFilters, b: ListFilters): boolean => {
  const scalarKeys: (keyof ListFilters)[] = [
    "from",
    "to",
    "outcome",
    "minEv",
    "maxEv",
    "search",
    "readyToSettle",
    "needsReview",
  ];
  for (const k of scalarKeys) {
    const av = a[k] ?? undefined;
    const bv = b[k] ?? undefined;
    if (av !== bv) return false;
  }
  if (!arrayEq(a.marketTypes, b.marketTypes)) return false;
  if (!arrayEq(a.softProviders, b.softProviders)) return false;
  return true;
};

const sortEqual = (
  a: { key: SortKey; dir: SortDir },
  b: { key: SortKey; dir: SortDir },
): boolean => a.key === b.key && a.dir === b.dir;

export function useBacktestPrefs() {
  const [savedDefaults, setSavedDefaults] =
    useLocalStorage<BacktestDefaults | null>(STORAGE_KEY_DEFAULTS, null);

  // Active defaults = user-saved defaults if present, otherwise system.
  const activeDefaults: BacktestDefaults = savedDefaults ?? SYSTEM_DEFAULTS;

  const [prefs, setPrefsRaw] = useLocalStorage<BacktestPrefs>(
    STORAGE_KEY_PREFS,
    {
      filters: sanitizeFilters(activeDefaults.filters),
      sort: activeDefaults.sort,
    },
  );

  const setFilters = useCallback(
    (updater: ListFilters | ((prev: ListFilters) => ListFilters)) => {
      setPrefsRaw((cur) => {
        const next =
          typeof updater === "function" ? updater(cur.filters) : updater;
        return { ...cur, filters: sanitizeFilters(next) };
      });
    },
    [setPrefsRaw],
  );

  const setSort = useCallback(
    (sort: { key: SortKey; dir: SortDir }) => {
      setPrefsRaw((cur) => ({ ...cur, sort }));
    },
    [setPrefsRaw],
  );

  // Reset filters + sort to active defaults (user-saved → or system).
  const resetToDefaults = useCallback(() => {
    setPrefsRaw((cur) => ({
      ...cur,
      filters: sanitizeFilters(activeDefaults.filters),
      sort: activeDefaults.sort,
    }));
  }, [setPrefsRaw, activeDefaults]);

  // Persist current filters + sort as the new default.
  const saveCurrentAsDefault = useCallback(() => {
    setSavedDefaults({
      filters: sanitizeFilters(prefs.filters),
      sort: prefs.sort,
    });
  }, [prefs.filters, prefs.sort, setSavedDefaults]);

  // Remove user-saved defaults; active defaults fall back to system.
  const clearSavedDefaults = useCallback(() => {
    setSavedDefaults(null);
  }, [setSavedDefaults]);

  const isAtDefaults = useMemo(
    () =>
      filtersEqual(prefs.filters, activeDefaults.filters) &&
      sortEqual(prefs.sort, activeDefaults.sort),
    [prefs.filters, prefs.sort, activeDefaults],
  );

  const hasSavedDefaults = savedDefaults !== null;

  return {
    filters: prefs.filters,
    setFilters,
    sort: prefs.sort,
    setSort,

    resetToDefaults,
    saveCurrentAsDefault,
    clearSavedDefaults,

    isAtDefaults,
    hasSavedDefaults,
  };
}
