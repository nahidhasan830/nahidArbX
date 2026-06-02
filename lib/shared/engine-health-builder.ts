import { getAllProviderStatus, getCachedStats, getSyncStatus } from "../store";
import {
  PROVIDER_IDS,
  PROVIDER_REGISTRY,
  type ProviderMetadata,
  type ProviderKey,
} from "../providers/registry";
import { isProviderRuntimeEnabled } from "../providers/runtime-state";
import { getConnectionHealth as getBCConnectionHealth } from "../adapters/betconstruct/client";
import { getTokenTTL } from "../auth/token-manager";
import { isScoreWebSocketConnected } from "../scores/websocket";
import { isBCPollingActive, getBCPollingCount } from "../scores/bc-poller";
import { pinnacleWsClient } from "../adapters/pinnacle/ws-client";
import { geniusSportsSyncService } from "../services/genius-sports-sync-service";
import { sabaSyncService } from "../services/saba-sync-service";
import { getReactiveDetectorStats } from "../background/reactive-detector";
import { getAllCircuitBreakerStats } from "./circuit-breaker";
import { getAllSessionDiagnostics } from "./session-diagnostics";

function providerMeta(id: ProviderKey): ProviderMetadata {
  return PROVIDER_REGISTRY[id] as ProviderMetadata;
}

export function buildConnectionHealth(): Record<string, unknown> {
  const ps = getAllProviderStatus();
  const bcHealth = getBCConnectionHealth();
  const pinnacleTokenTTL = getTokenTTL();

  const health: Record<string, unknown> = {
    betconstruct: {
      connected: bcHealth.connected,
      consecutiveTimeouts: bcHealth.consecutiveTimeouts,
      isReconnecting: bcHealth.isReconnecting,
      pendingRequests: bcHealth.pendingRequests,
    },
    pinnacle: {
      hasToken: pinnacleTokenTTL !== null && pinnacleTokenTTL > 0,
      tokenTTL: pinnacleTokenTTL,
      expiresIn:
        pinnacleTokenTTL !== null
          ? `${Math.round(pinnacleTokenTTL / 60000)}m`
          : null,
    },
    scores: {
      pinnacleWs: { connected: isScoreWebSocketConnected() },
      bcPoller: {
        active: isBCPollingActive(),
        eventCount: getBCPollingCount(),
      },
    },
  };

  for (const id of PROVIDER_IDS) {
    if (id === "betconstruct" || id === "pinnacle") continue;
    const s = ps[id];
    health[id] = {
      status: s?.status ?? "unknown",
      lastFetch: s?.lastFetch?.toISOString() ?? null,
      error: s?.error ?? null,
    };
  }

  // Reactive engine diagnostics
  const wsStatus = pinnacleWsClient.getConnectionStatus();
  const loopCounts = geniusSportsSyncService.getActiveLoopCounts();
  const sabaStatus = sabaSyncService.getStatus();
  const detectorStats = getReactiveDetectorStats();
  const currentSyncStatus = getSyncStatus();
  const cachedStats = getCachedStats();

  // Circuit breaker summary — only include providers with non-closed state
  const cbStats = getAllCircuitBreakerStats();
  const circuitBreakers: Record<string, { state: string; failures: number }> =
    {};
  for (const [id, stats] of Object.entries(cbStats)) {
    circuitBreakers[id] = { state: stats.state, failures: stats.failures };
  }

  const activeEventsByProvider: Partial<Record<ProviderKey, number>> = {
    pinnacle: wsStatus.subscribedEvents,
    "ninewickets-sportsbook": loopCounts.ninewickets,
    "velki-sportsbook": loopCounts.velki,
    "saba-sportsbook": sabaStatus.activeEvents,
  };
  const connectedByProvider: Partial<Record<ProviderKey, boolean>> = {
    pinnacle: wsStatus.connected,
    betconstruct: bcHealth.connected,
    "ninewickets-sportsbook": loopCounts.ninewickets > 0,
    "velki-sportsbook": loopCounts.velki > 0,
    "saba-sportsbook": sabaStatus.connected,
  };
  const pendingRequestsByProvider: Partial<Record<ProviderKey, number>> = {
    betconstruct: bcHealth.pendingRequests,
    "saba-sportsbook": sabaStatus.pending,
  };
  const providerRuntime: Record<
    string,
    {
      enabled: boolean;
      kind: string;
      platform: string | null;
      status: string;
      lastFetch: string | null;
      error: string | null;
      connected: boolean | null;
      activeEvents: number | null;
      pendingRequests: number | null;
      circuitBreaker: { state: string; failures: number } | null;
    }
  > = {};
  for (const id of PROVIDER_IDS) {
    const s = ps[id];
    const cb = cbStats[id];
    const meta = providerMeta(id);
    providerRuntime[id] = {
      enabled: isProviderRuntimeEnabled(id),
      kind: meta.integration.kind,
      platform: meta.integration.platform ?? null,
      status: s?.status ?? "unknown",
      lastFetch: s?.lastFetch?.toISOString() ?? null,
      error: s?.error ?? null,
      connected: connectedByProvider[id] ?? null,
      activeEvents: activeEventsByProvider[id] ?? null,
      pendingRequests: pendingRequestsByProvider[id] ?? null,
      circuitBreaker: cb
        ? { state: cb.state, failures: cb.failures }
        : null,
    };
  }

  // Session capture diagnostics — per-provider step-level status
  const sessionCapture = getAllSessionDiagnostics();

  health.engine = {
    pinnacleWs: {
      connected: wsStatus.connected,
      subscribedEvents: wsStatus.subscribedEvents,
    },
    pollingLoops: {
      ninewickets: loopCounts.ninewickets,
      velki: loopCounts.velki,
      saba: sabaStatus.activeEvents,
    },
    saba: {
      connected: sabaStatus.connected,
      activeEvents: sabaStatus.activeEvents,
      pendingRequests: sabaStatus.pending,
    },
    providerRuntime,
    detector: {
      running: detectorStats.running,
      totalPasses: detectorStats.totalPasses,
      avgPassDurationMs: detectorStats.avgPassDurationMs,
      lastPassAt: detectorStats.lastPassAt,
    },
    firstSyncComplete: currentSyncStatus.lastSyncEnd !== null,
    isSyncing: currentSyncStatus.isSyncing,
    matchedCount: cachedStats.matchedCount,
    totalEvents: cachedStats.totalEvents,
    circuitBreakers,
    sessionCapture,
  };

  return health;
}
