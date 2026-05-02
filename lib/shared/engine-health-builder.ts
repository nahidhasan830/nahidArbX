/**
 * Builds the connectionHealth object from engine-process singletons.
 *
 * Extracted so both the engine HTTP API and the legacy Next.js route
 * can call it. Only meaningful inside the engine process — returns
 * zeros/false in the web-only Next.js process.
 */

import { getAllProviderStatus, getSyncStatus } from "../store";
import { PROVIDER_IDS } from "../providers/registry";
import { getConnectionHealth as getBCConnectionHealth } from "../adapters/betconstruct/client";
import { getTokenTTL } from "../auth/token-manager";
import { isScoreWebSocketConnected } from "../scores/websocket";
import { isBCPollingActive, getBCPollingCount } from "../scores/bc-poller";
import { pinnacleWsClient } from "../adapters/pinnacle/ws-client";
import { geniusSportsSyncService } from "../services/genius-sports-sync-service";
import { getReactiveDetectorStats } from "../background/reactive-detector";

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
  const detectorStats = getReactiveDetectorStats();
  const currentSyncStatus = getSyncStatus();

  health.engine = {
    pinnacleWs: {
      connected: wsStatus.connected,
      subscribedEvents: wsStatus.subscribedEvents,
    },
    pollingLoops: {
      ninewickets: loopCounts.ninewickets,
      velki: loopCounts.velki,
    },
    detector: {
      running: detectorStats.running,
      totalPasses: detectorStats.totalPasses,
      avgPassDurationMs: detectorStats.avgPassDurationMs,
      lastPassAt: detectorStats.lastPassAt,
    },
    firstSyncComplete: currentSyncStatus.lastSyncEnd !== null,
    isSyncing: currentSyncStatus.isSyncing,
  };

  return health;
}
