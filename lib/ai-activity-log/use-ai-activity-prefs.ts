"use client";

import { useCallback } from "react";
import { useLocalStorage } from "@/components/hooks/useLocalStorage";
import type { DatePresetKey } from "@/lib/bets-history/date-presets";

type PersistedFilters = {
  from?: string;
  to?: string;
  systems?: string[];
  statuses?: string[];
  triggers?: string[];
  endpoints?: string[];
  search?: string;
};

type Prefs = {
  filters: PersistedFilters;
  datePreset: DatePresetKey;
};

const STORAGE_KEY = "ai-activity-log:prefs:v1";

const DEFAULTS: Prefs = {
  filters: {},
  datePreset: "all",
};

export function useAiActivityPrefs() {
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

  const setDatePreset = useCallback(
    (preset: DatePresetKey) => {
      setPrefs((cur) => ({
        ...cur,
        datePreset: preset,
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
    datePreset: prefs.datePreset,
    setDatePreset,
  };
}
