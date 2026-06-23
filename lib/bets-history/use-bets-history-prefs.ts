"use client";

import { useCallback, useMemo } from "react";
import { useLocalStorage } from "@/components/hooks/useLocalStorage";
import type { ListFilters } from "./api-client";
import type { DatePresetKey } from "./date-presets";

export type SortKey =
  | "firstSeenAt"
  | "evPctMax"
  | "kellyFraction"
  | "tickCount"
  | "eventStartTime";
export type SortDir = "asc" | "desc" | "none";

export type BetsHistoryPrefs = {
  filters: ListFilters;
  sort: { key: SortKey; dir: SortDir };
  capturedPreset?: DatePresetKey;
  kickoffPreset?: DatePresetKey;
};

export type BetsHistoryDefaults = {
  filters: ListFilters;
  sort: { key: SortKey; dir: SortDir };
  capturedPreset?: DatePresetKey;
  kickoffPreset?: DatePresetKey;
};

const SYSTEM_DEFAULTS: BetsHistoryDefaults = {
  filters: {},
  sort: { key: "firstSeenAt", dir: "desc" },
  capturedPreset: "all",
  kickoffPreset: "all",
};

const PAGE_SIZE = 100;
const SORT_KEYS = new Set<SortKey>([
  "firstSeenAt",
  "evPctMax",
  "kellyFraction",
  "tickCount",
  "eventStartTime",
]);

const STORAGE_KEY_PREFS = "bets-history:prefs:v3";
const STORAGE_KEY_DEFAULTS = "bets-history:defaults:v3";

const LEGACY_KEY_PREFS = "backtest:prefs:v3";
const LEGACY_KEY_DEFAULTS = "backtest:defaults:v3";
if (typeof window !== "undefined") {
  try {
    for (const [legacy, next] of [
      [LEGACY_KEY_PREFS, STORAGE_KEY_PREFS],
      [LEGACY_KEY_DEFAULTS, STORAGE_KEY_DEFAULTS],
    ] as const) {
      const legacyValue = window.localStorage.getItem(legacy);
      if (legacyValue && window.localStorage.getItem(next) === null) {
        window.localStorage.setItem(next, legacyValue);
      }
      if (legacyValue) window.localStorage.removeItem(legacy);
    }
  } catch {
  }
}

const sanitizeFilters = (
  f: ListFilters,
  capturedPreset?: DatePresetKey,
  kickoffPreset?: DatePresetKey,
): ListFilters => {
  const { offset: _offset, limit: _limit, ...rest } = f;
  const out: ListFilters = { ...rest, limit: PAGE_SIZE, offset: 0 };
  if (
    capturedPreset &&
    capturedPreset !== "all" &&
    capturedPreset !== "custom"
  ) {
    out.from = undefined;
    out.to = undefined;
  }
  if (kickoffPreset && kickoffPreset !== "all" && kickoffPreset !== "custom") {
    out.eventFrom = undefined;
    out.eventTo = undefined;
  }
  return out;
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
    "eventFrom",
    "eventTo",
    "outcome",
    "minEv",
    "maxEv",
    "search",
    "readyToSettle",
    "needsReview",
    "placedOnly",
  ];
  for (const k of scalarKeys) {
    const av = a[k] ?? undefined;
    const bv = b[k] ?? undefined;
    if (av !== bv) return false;
  }
  if (!arrayEq(a.marketTypes, b.marketTypes)) return false;
  if (!arrayEq(a.softProviders, b.softProviders)) return false;
  if (!arrayEq(a.settledBySources, b.settledBySources)) return false;
  return true;
};

const sortEqual = (
  a: { key: SortKey; dir: SortDir },
  b: { key: SortKey; dir: SortDir },
): boolean => a.key === b.key && a.dir === b.dir;

const sanitizeSort = (
  sort: BetsHistoryPrefs["sort"] | null | undefined,
): BetsHistoryPrefs["sort"] => {
  if (sort && SORT_KEYS.has(sort.key)) return sort;
  return SYSTEM_DEFAULTS.sort;
};

export function useBetsHistoryPrefs() {
  const [savedDefaults, setSavedDefaults] =
    useLocalStorage<BetsHistoryDefaults | null>(STORAGE_KEY_DEFAULTS, null);

  const activeDefaults: BetsHistoryDefaults = useMemo(
    () =>
      savedDefaults
        ? {
            ...savedDefaults,
            sort: sanitizeSort(savedDefaults.sort),
          }
        : SYSTEM_DEFAULTS,
    [savedDefaults],
  );

  const [prefs, setPrefsRaw] = useLocalStorage<BetsHistoryPrefs>(
    STORAGE_KEY_PREFS,
    {
      filters: sanitizeFilters(
        activeDefaults.filters,
        activeDefaults.capturedPreset,
        activeDefaults.kickoffPreset,
      ),
      sort: sanitizeSort(activeDefaults.sort),
      capturedPreset: activeDefaults.capturedPreset ?? "all",
      kickoffPreset: activeDefaults.kickoffPreset ?? "all",
    },
  );

  const safePrefs: BetsHistoryPrefs = useMemo(
    () => ({
      ...prefs,
      sort: sanitizeSort(prefs.sort),
    }),
    [prefs],
  );

  const setFilters = useCallback(
    (updater: ListFilters | ((prev: ListFilters) => ListFilters)) => {
      setPrefsRaw((cur) => {
        const next =
          typeof updater === "function" ? updater(cur.filters) : updater;
        return {
          ...cur,
          filters: sanitizeFilters(next, cur.capturedPreset, cur.kickoffPreset),
        };
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

  const setCapturedPreset = useCallback(
    (preset: DatePresetKey) => {
      setPrefsRaw((cur) => ({
        ...cur,
        capturedPreset: preset,
        filters: sanitizeFilters(cur.filters, preset, cur.kickoffPreset),
      }));
    },
    [setPrefsRaw],
  );

  const setKickoffPreset = useCallback(
    (preset: DatePresetKey) => {
      setPrefsRaw((cur) => ({
        ...cur,
        kickoffPreset: preset,
        filters: sanitizeFilters(cur.filters, cur.capturedPreset, preset),
      }));
    },
    [setPrefsRaw],
  );

  const resetToDefaults = useCallback(() => {
    setPrefsRaw((cur) => ({
      ...cur,
      filters: sanitizeFilters(
        activeDefaults.filters,
        activeDefaults.capturedPreset,
        activeDefaults.kickoffPreset,
      ),
      sort: sanitizeSort(activeDefaults.sort),
      capturedPreset: activeDefaults.capturedPreset ?? "all",
      kickoffPreset: activeDefaults.kickoffPreset ?? "all",
    }));
  }, [setPrefsRaw, activeDefaults]);

  const saveCurrentAsDefault = useCallback(() => {
    setSavedDefaults({
      filters: sanitizeFilters(
        safePrefs.filters,
        safePrefs.capturedPreset,
        safePrefs.kickoffPreset,
      ),
      sort: safePrefs.sort,
      capturedPreset: safePrefs.capturedPreset,
      kickoffPreset: safePrefs.kickoffPreset,
    });
  }, [
    safePrefs.filters,
    safePrefs.sort,
    safePrefs.capturedPreset,
    safePrefs.kickoffPreset,
    setSavedDefaults,
  ]);

  const clearSavedDefaults = useCallback(() => {
    setSavedDefaults(null);
  }, [setSavedDefaults]);

  const isAtDefaults = useMemo(
    () =>
      filtersEqual(safePrefs.filters, activeDefaults.filters) &&
      sortEqual(safePrefs.sort, activeDefaults.sort) &&
      (safePrefs.capturedPreset ?? "all") ===
        (activeDefaults.capturedPreset ?? "all") &&
      (safePrefs.kickoffPreset ?? "all") ===
        (activeDefaults.kickoffPreset ?? "all"),
    [
      safePrefs.filters,
      safePrefs.sort,
      safePrefs.capturedPreset,
      safePrefs.kickoffPreset,
      activeDefaults,
    ],
  );

  const hasSavedDefaults = savedDefaults !== null;

  return {
    filters: safePrefs.filters,
    setFilters,
    sort: safePrefs.sort,
    setSort,
    capturedPreset: safePrefs.capturedPreset ?? "all",
    kickoffPreset: safePrefs.kickoffPreset ?? "all",
    setCapturedPreset,
    setKickoffPreset,

    resetToDefaults,
    saveCurrentAsDefault,
    clearSavedDefaults,

    isAtDefaults,
    hasSavedDefaults,
  };
}
