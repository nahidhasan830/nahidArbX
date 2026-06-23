"use client";


import { useQuery } from "@tanstack/react-query";

export interface ProviderRuntimeHealth {
  enabled: boolean;
  kind: "polling" | "websocket" | "managed" | string;
  platform: string | null;
  status: string;
  lastFetch: string | null;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
  lastErrorAt?: string | null;
  unhealthySinceAt?: string | null;
  lastError?: string | null;
  error: string | null;
  consecutiveFailures?: number;
  connected: boolean | null;
  activeEvents: number | null;
  pendingRequests: number | null;
  circuitBreaker: { state: string; failures: number } | null;
}

export interface EngineStatus {
  pinnacleWs: {
    connected: boolean;
    subscribedEvents: number;
  };
  pollingLoops: {
    ninewickets: number;
    velki: number;
    saba?: number;
    [providerId: string]: number | undefined;
  };
  saba?: {
    connected: boolean;
    activeEvents: number;
    pendingRequests: number;
  };
  providerRuntime?: Record<string, ProviderRuntimeHealth>;
  detector: {
    running: boolean;
    totalPasses: number;
    avgPassDurationMs: number;
    lastPassAt: number | null;
  };
  firstSyncComplete: boolean;
  isSyncing: boolean;
  matchedCount?: number;
  totalEvents?: number;
  circuitBreakers?: Record<string, { state: string; failures: number }>;
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

export function useEngineHealth() {
  return useQuery({
    queryKey: ["engine-health"],
    queryFn: fetchEngineHealth,
    refetchInterval: 5_000,
    staleTime: 3_000,
    placeholderData: (prev) => prev,
  });
}
