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
  | "eventStartTime"
  | "mlScore";
export type SortDir = "asc" | "desc" | "none";

export type BetsHistoryPrefs = {
  filters: ListFilters;
  sort: { key: SortKey; dir: SortDir };
  /** Active date preset for captured-time filter (firstSeenAt). */
  capturedPreset?: DatePresetKey;
  /** Active date preset for kickoff-time filter (eventStartTime). */
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

const STORAGE_KEY_PREFS = "bets-history:prefs:v3";
const STORAGE_KEY_DEFAULTS = "bets-history:defaults:v3";

// One-time migration from the legacy "backtest:*" keys. Runs at module load
// in the browser — cheap enough to not bother lazy-initialising. Remove this
// shim after ~2 releases once we're confident every returning user has been
// migrated.
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
      // Always drop the legacy key once we've handled migration once.
      if (legacyValue) window.localStorage.removeItem(legacy);
    }
  } catch {
    // storage disabled / quota / cross-origin — safe to ignore.
  }
}

// Fields we persist in prefs (not offset — always start at page 0 on reload).
// When a rolling date preset is active (anything except "all" / "custom"),
// we strip the baked `from`/`to` (or `eventFrom`/`eventTo`) so they get
// re-resolved from the preset key on each refetch tick. Otherwise reloading
// hours later would replay a stale window.
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

export function useBetsHistoryPrefs() {
  const [savedDefaults, setSavedDefaults] =
    useLocalStorage<BetsHistoryDefaults | null>(STORAGE_KEY_DEFAULTS, null);

  // Active defaults = user-saved defaults if present, otherwise system.
  const activeDefaults: BetsHistoryDefaults = savedDefaults ?? SYSTEM_DEFAULTS;

  const [prefs, setPrefsRaw] = useLocalStorage<BetsHistoryPrefs>(
    STORAGE_KEY_PREFS,
    {
      filters: sanitizeFilters(
        activeDefaults.filters,
        activeDefaults.capturedPreset,
        activeDefaults.kickoffPreset,
      ),
      sort: activeDefaults.sort,
      capturedPreset: activeDefaults.capturedPreset ?? "all",
      kickoffPreset: activeDefaults.kickoffPreset ?? "all",
    },
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

  // Reset filters + sort + presets to active defaults (user-saved → or system).
  const resetToDefaults = useCallback(() => {
    setPrefsRaw((cur) => ({
      ...cur,
      filters: sanitizeFilters(
        activeDefaults.filters,
        activeDefaults.capturedPreset,
        activeDefaults.kickoffPreset,
      ),
      sort: activeDefaults.sort,
      capturedPreset: activeDefaults.capturedPreset ?? "all",
      kickoffPreset: activeDefaults.kickoffPreset ?? "all",
    }));
  }, [setPrefsRaw, activeDefaults]);

  // Persist current filters + sort + presets as the new default.
  const saveCurrentAsDefault = useCallback(() => {
    setSavedDefaults({
      filters: sanitizeFilters(
        prefs.filters,
        prefs.capturedPreset,
        prefs.kickoffPreset,
      ),
      sort: prefs.sort,
      capturedPreset: prefs.capturedPreset,
      kickoffPreset: prefs.kickoffPreset,
    });
  }, [
    prefs.filters,
    prefs.sort,
    prefs.capturedPreset,
    prefs.kickoffPreset,
    setSavedDefaults,
  ]);

  // Remove user-saved defaults; active defaults fall back to system.
  const clearSavedDefaults = useCallback(() => {
    setSavedDefaults(null);
  }, [setSavedDefaults]);

  const isAtDefaults = useMemo(
    () =>
      filtersEqual(prefs.filters, activeDefaults.filters) &&
      sortEqual(prefs.sort, activeDefaults.sort) &&
      (prefs.capturedPreset ?? "all") ===
        (activeDefaults.capturedPreset ?? "all") &&
      (prefs.kickoffPreset ?? "all") ===
        (activeDefaults.kickoffPreset ?? "all"),
    [
      prefs.filters,
      prefs.sort,
      prefs.capturedPreset,
      prefs.kickoffPreset,
      activeDefaults,
    ],
  );

  const hasSavedDefaults = savedDefaults !== null;

  return {
    filters: prefs.filters,
    setFilters,
    sort: prefs.sort,
    setSort,
    capturedPreset: prefs.capturedPreset ?? "all",
    kickoffPreset: prefs.kickoffPreset ?? "all",
    setCapturedPreset,
    setKickoffPreset,

    resetToDefaults,
    saveCurrentAsDefault,
    clearSavedDefaults,

    isAtDefaults,
    hasSavedDefaults,
  };
}
