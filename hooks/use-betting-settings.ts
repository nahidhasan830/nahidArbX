"use client";

/**
 * Client hook that fetches the singleton /api/betting-settings once per
 * mount and returns the row + catalog of strategies. The hook is
 * intentionally thin — no SWR, no global cache — because the backend
 * read path is already memoized in-process and the settings change at
 * most a few times a day. A page reload pulls the latest; an explicit
 * `refresh()` is exposed for the dashboard editor card.
 */
import { useCallback, useEffect, useState } from "react";

export interface Strategy {
  id: string;
  label: string;
  description: string;
}

export interface BettingSettingsClient {
  id: number;
  strategyId: string;
  useLiveBalance: boolean;
  manualBankrollBdt: number;
  unitSizeBdt: number;
  kellyCapPct: number;
  minStakeBdt: number;
  stakeBucketBdt: number;
  minEvPct: number;
  maxOddsAgeSec: number;
  dailyMaxLossBdt: number | null;
  dailyMaxStakeBdt: number | null;
  maxConcurrentExposureBdt: number | null;
  maxBetsPerDay: number | null;
  cooldownAfterLossSec: number | null;
  updatedAt: string;
}

interface State {
  settings: BettingSettingsClient | null;
  strategies: Strategy[];
  loading: boolean;
  error: string | null;
}

export function useBettingSettings() {
  const [state, setState] = useState<State>({
    settings: null,
    strategies: [],
    loading: true,
    error: null,
  });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/betting-settings", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        settings: BettingSettingsClient;
        strategies: Strategy[];
      };
      setState({
        settings: data.settings,
        strategies: data.strategies,
        loading: false,
        error: null,
      });
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ...state, refresh };
}
