/**
 * Health Check API Endpoint
 *
 * Used by:
 * - PM2 for process health monitoring
 * - Docker/Kubernetes for container health probes
 * - Load balancers for backend availability
 * - External monitoring services (Datadog, Hyperping, etc.)
 *
 * Endpoints:
 * - GET /api/health - Full health check (detailed)
 * - GET /api/health?simple=true - Simple health check (just status)
 *
 * Response codes:
 * - 200: Healthy
 * - 503: Unhealthy (triggers restart in PM2/Docker)
 */

import { NextResponse } from "next/server";
import {
  getSystemHealth,
  getUptimeString,
  getMemoryStats,
} from "@/lib/shared/health-manager";
import { isSchedulerRunning } from "@/lib/background/fetcher";
import { getSyncStatus, getEvents, getValueBets } from "@/lib/store";
import { getConnectionHealth as getBCConnectionHealth } from "@/lib/adapters/betconstruct/client";
import { isProviderRuntimeEnabled } from "@/lib/providers/runtime-state";
import { isScoreWebSocketConnected } from "@/lib/scores/websocket";
import { getAllCircuitBreakerStats } from "@/lib/shared/circuit-breaker";
import { getStoreStats, getMatchedMarketsCount } from "@/lib/atoms/store";
import { getMatchCacheStats } from "@/lib/matching";
import { getSimilarityCacheStats } from "@/lib/matching/similarity-cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const simple = searchParams.get("simple") === "true";

  // Get component health
  const bcEnabled = isProviderRuntimeEnabled("betconstruct");
  const bcHealth = getBCConnectionHealth();
  const scoresConnected = isScoreWebSocketConnected();
  const schedulerRunning = isSchedulerRunning();
  const syncStatus = getSyncStatus();

  // Determine overall status
  // For simple health checks (load balancers), just check if app is running
  // For detailed checks, include component health.
  // A disabled provider is "not expected to be healthy" — treat it as OK for
  // overall status so disabling BC doesn't flip the system into degraded.
  const bcHealthy = bcHealth.connected && bcHealth.consecutiveTimeouts < 5;

  // Simple check: app is running and scheduler is active (for deployment health checks)
  const isAppHealthy = schedulerRunning;
  // Full check: all critical components healthy
  const isFullyHealthy = (bcHealthy || !bcEnabled) && schedulerRunning;

  // Simple health check (for load balancers and deployment)
  // Always returns OK - if this endpoint responds, the app is running
  if (simple) {
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  // Get full system health
  const systemHealth = getSystemHealth();
  const circuitBreakers = getAllCircuitBreakerStats();

  // Memory stats
  const mem = process.memoryUsage();
  const memStats = getMemoryStats();
  const atomsStoreStats = getStoreStats();
  const matchCacheStats = getMatchCacheStats();
  const similarityCacheStats = getSimilarityCacheStats();

  // Build detailed response - use systemHealth status (smarter logic)
  const response = {
    status: systemHealth.status,
    uptime: getUptimeString(),
    timestamp: new Date().toISOString(),

    // Component health
    components: {
      betconstruct: {
        status: !bcEnabled
          ? "disabled"
          : bcHealthy
            ? "healthy"
            : bcHealth.isReconnecting
              ? "recovering"
              : "unhealthy",
        enabled: bcEnabled,
        connected: bcHealth.connected,
        sessionId: bcHealth.sessionId ? "active" : null,
        consecutiveTimeouts: bcHealth.consecutiveTimeouts,
        isReconnecting: bcHealth.isReconnecting,
        pendingRequests: bcHealth.pendingRequests,
      },
      scores: {
        status: scoresConnected ? "healthy" : "unhealthy",
        connected: scoresConnected,
      },
      scheduler: {
        status: schedulerRunning ? "healthy" : "stopped",
        running: schedulerRunning,
        isSyncing: syncStatus.isSyncing,
        currentPhase: syncStatus.currentPhase,
        lastSyncEnd: syncStatus.lastSyncEnd?.toISOString() || null,
      },
    },

    // Circuit breaker status
    circuitBreakers: Object.fromEntries(
      Object.entries(circuitBreakers).map(([id, stats]) => [
        id,
        {
          state: stats.state,
          failures: stats.failures,
          successes: stats.successes,
          timeouts: stats.timeouts,
        },
      ]),
    ),

    // Memory usage and store sizes
    memory: {
      heapUsed: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
      heapTotal: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
      rss: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
      external: Math.round((mem.external / 1024 / 1024) * 100) / 100,
      heapUsedPct: memStats.heapPct,
      stores: {
        events: getEvents().length,
        odds: atomsStoreStats.totalOddsRecords,
        families: atomsStoreStats.totalFamilies,
        matchedMarkets: getMatchedMarketsCount(),
        valueBets: getValueBets().length,
        matchCache: matchCacheStats.cachedEvents,
        similarityCache: {
          size: similarityCacheStats.size,
          maxSize: similarityCacheStats.maxSize,
          hitRate: matchCacheStats.bucketSkipRate,
        },
      },
      alert: memStats.alert,
    },

    // System-level health from health manager
    systemHealth: {
      status: systemHealth.status,
      components: Object.fromEntries(
        Object.entries(systemHealth.components).map(([id, health]) => [
          id,
          {
            status: health.status,
            consecutiveFailures: health.consecutiveFailures,
          },
        ]),
      ),
    },
  };

  // Return 200 even if degraded (for app monitoring)
  // Only return 503 if app itself is down
  return NextResponse.json(response, { status: isAppHealthy ? 200 : 503 });
}

/**
 * POST /api/health - Trigger healing actions
 *
 * Body:
 * - { action: "heal", component: "betconstruct" } - Heal specific component
 * - { action: "healAll" } - Heal all unhealthy components
 * - { action: "restart" } - Request process restart (for PM2)
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, component } = body;

    switch (action) {
      case "heal": {
        if (!component) {
          return NextResponse.json(
            { ok: false, error: "component required" },
            { status: 400 },
          );
        }

        // Trigger component-specific healing
        const { healComponent } = await import("@/lib/shared/health-manager");
        const success = await healComponent(component);

        return NextResponse.json({ ok: success, component });
      }

      case "healAll": {
        const { healAll } = await import("@/lib/shared/health-manager");
        const results = await healAll();

        return NextResponse.json({ ok: true, results });
      }

      case "restart": {
        // Graceful shutdown - PM2 will restart us
        console.log("[Health] Restart requested via API");

        // Delay exit to allow response to be sent
        setTimeout(() => {
          process.exit(0);
        }, 100);

        return NextResponse.json({ ok: true, message: "Restart initiated" });
      }

      default:
        return NextResponse.json(
          { ok: false, error: "Unknown action" },
          { status: 400 },
        );
    }
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
