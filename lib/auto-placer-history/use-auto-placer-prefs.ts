"use client";

/**
 * Lightweight preferences hook for the Auto-Placer Log page.
 *
 * Persists filter state + date preset to localStorage so the
 * operator's view survives page refreshes.
 */
import { useCallback } from "react";
import { useLocalStorage } from "@/components/hooks/useLocalStorage";
import type { DatePresetKey } from "@/lib/bets-history/date-presets";

/** Subset of filter fields we actually persist. */
type PersistedFilters = {
  from?: string;
  to?: string;
  statuses?: string[];
  gates?: string[];
  softProviders?: string[];
  search?: string;
};

type Prefs = {
  filters: PersistedFilters;
  datePreset: DatePresetKey;
};

const STORAGE_KEY = "auto-placer-log:prefs:v1";

const DEFAULTS: Prefs = {
  filters: {},
  datePreset: "all",
};

export function useAutoPlacerPrefs() {
  const [prefs, setPrefs] = useLocalStorage<Prefs>(STORAGE_KEY, DEFAULTS);

  const setFilters = useCallback(
    (
      updater:
        | PersistedFilters
        | ((prev: PersistedFilters) => PersistedFilters),
    ) => {
      setPrefs((cur) => {
        const next =
          typeof updater === "function" ? updater(cur.filters) : updater;
        return { ...cur, filters: next };
      });
    },
    [setPrefs],
  );

  const setPlacedPreset = useCallback(
    (preset: DatePresetKey) => {
      setPrefs((cur) => ({
        ...cur,
        datePreset: preset,
        // Clear baked dates when switching to a rolling preset
        filters:
          preset !== "all" && preset !== "custom"
            ? { ...cur.filters, from: undefined, to: undefined }
            : cur.filters,
      }));
    },
    [setPrefs],
  );

  return {
    filters: prefs.filters,
    setFilters,
    placedPreset: prefs.datePreset,
    setPlacedPreset,
  };
}
