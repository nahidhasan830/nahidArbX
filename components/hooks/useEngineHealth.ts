"use client";

/**
 * useEngineHealth — lightweight poll for reactive engine status.
 *
 * Uses the existing `?fields=connectionHealth` fast-path in `/api/value-bets`
 * which skips all event analysis and just returns engine diagnostics. This
 * lets the status bar and boot indicator update every 5s independently of
 * the heavy event data query.
 */

import { useQuery } from "@tanstack/react-query";

export interface EngineStatus {
  pinnacleWs: {
    connected: boolean;
    subscribedEvents: number;
  };
  pollingLoops: {
    ninewickets: number;
    velki: number;
  };
  detector: {
    running: boolean;
    totalPasses: number;
    avgPassDurationMs: number;
    lastPassAt: number | null;
  };
  firstSyncComplete: boolean;
  isSyncing: boolean;
}

export interface ConnectionHealth {
  betconstruct: {
    connected: boolean;
    consecutiveTimeouts: number;
    isReconnecting: boolean;
    pendingRequests: number;
  };
  pinnacle?: {
    hasToken: boolean;
    tokenTTL: number | null;
    expiresIn: string | null;
  };
  scores?: {
    pinnacleWs: { connected: boolean };
    bcPoller: { active: boolean; eventCount: number };
  };
  engine?: EngineStatus;
  [providerId: string]: unknown;
}

async function fetchEngineHealth(): Promise<ConnectionHealth | null> {
  try {
    const res = await fetch("/api/value-bets?fields=connectionHealth");
    if (!res.ok) return null;
    const data = await res.json();
    return (data.connectionHealth as ConnectionHealth) ?? null;
  } catch {
    return null;
  }
}

/**
 * Poll engine health every 5s. Near-zero server cost — the API
 * fast-path only calls `buildConnectionHealth()` (no event analysis).
 */
export function useEngineHealth() {
  return useQuery({
    queryKey: ["engine-health"],
    queryFn: fetchEngineHealth,
    refetchInterval: 5_000,
    staleTime: 3_000,
    // Don't show loading state after initial load — keep previous data visible
    placeholderData: (prev) => prev,
  });
}
