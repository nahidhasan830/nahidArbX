/**
 * Unified Health Manager
 *
 * Coordinates health monitoring and auto-healing across all system components.
 * Provides a single source of truth for system health status.
 *
 * Components monitored:
 * - Provider connections (BetConstruct WebSocket, Pinnacle API, NineWickets API)
 * - Circuit breakers (per-provider resilience)
 * - Score WebSocket (Pinnacle live scores)
 * - Background sync scheduler
 *
 * Healing strategies:
 * 1. Component-level: Individual reconnect attempts
 * 2. Circuit breaker: Fail fast and recover automatically
 * 3. Process-level: Exit for PM2 restart (last resort)
 */

import {
  getAllCircuitBreakerStats,
  type CircuitBreakerStats,
} from "./circuit-breaker";
import { logger } from "./logger";

// ============================================
// Types
// ============================================

export type ComponentStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface ComponentHealth {
  status: ComponentStatus;
  lastCheck: number;
  details?: Record<string, unknown>;
  consecutiveFailures: number;
}

export interface SystemHealth {
  status: ComponentStatus;
  uptime: number;
  components: Record<string, ComponentHealth>;
  circuitBreakers: Record<string, CircuitBreakerStats>;
  lastHealthCheck: number;
}

// Callback types for component health providers
type HealthProvider = () => ComponentHealth;
type HealingAction = () => Promise<boolean>;

// ============================================
// Health Manager State
// ============================================

const startTime = Date.now();
const healthProviders = new Map<string, HealthProvider>();
const healingActions = new Map<string, HealingAction>();
const componentFailures = new Map<string, number>();

// Thresholds for healing actions
const DEGRADED_THRESHOLD = 3; // Failures before marking as degraded
const UNHEALTHY_THRESHOLD = 5; // Failures before marking as unhealthy
const FATAL_THRESHOLD = 10; // Failures before triggering process restart

// Fatal failure callback (set by background fetcher)
let onFatalCallback: (() => void) | null = null;

// Health check interval
let healthCheckInterval: NodeJS.Timeout | null = null;
const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds

// ============================================
// Component Registration
// ============================================

/**
 * Register a health provider for a component
 */
export function registerHealthProvider(
  componentId: string,
  provider: HealthProvider,
): void {
  healthProviders.set(componentId, provider);
  componentFailures.set(componentId, 0);
}

/**
 * Register a healing action for a component
 */
export function registerHealingAction(
  componentId: string,
  action: HealingAction,
): void {
  healingActions.set(componentId, action);
}

/**
 * Set callback for fatal failures (process restart)
 */
export function onFatalFailure(callback: () => void): void {
  onFatalCallback = callback;
}

// ============================================
// Health Checks
// ============================================

/**
 * Get health status for a specific component
 */
export function getComponentHealth(componentId: string): ComponentHealth {
  const provider = healthProviders.get(componentId);
  if (!provider) {
    return {
      status: "unknown",
      lastCheck: Date.now(),
      consecutiveFailures: 0,
    };
  }

  try {
    return provider();
  } catch (error) {
    logger.error("HealthManager", `Error checking ${componentId}:`, error);
    return {
      status: "unhealthy",
      lastCheck: Date.now(),
      consecutiveFailures: componentFailures.get(componentId) || 0,
      details: {
        error: error instanceof Error ? error.message : "Unknown error",
      },
    };
  }
}

/**
 * Get full system health status
 *
 * Status logic:
 * - "healthy": All components working
 * - "degraded": Some components down, but app can still function
 * - "unhealthy": Critical components down, app cannot function
 *
 * Critical components: scheduler (must be running)
 * Data providers: betconstruct, pinnacle, ninewickets-* (need at least 1)
 */
export function getSystemHealth(): SystemHealth {
  const components: Record<string, ComponentHealth> = {};
  let unhealthyCount = 0;

  // Critical components that must be healthy
  const CRITICAL = ["scheduler"];
  // Data providers - need at least one working for the app to be useful
  const DATA_PROVIDERS = [
    "betconstruct",
    "pinnacle",
    "ninewickets-exchange",
    "ninewickets-sportsbook",
  ];

  for (const [id] of healthProviders) {
    const health = getComponentHealth(id);
    components[id] = health;

    if (health.status === "unhealthy") {
      unhealthyCount++;
    }
  }

  // Check critical components
  const criticalHealthy = CRITICAL.every((id) => {
    const comp = components[id];
    return comp && comp.status !== "unhealthy";
  });

  // Check if at least one data provider works
  const hasWorkingProvider = DATA_PROVIDERS.some((id) => {
    const comp = components[id];
    return comp && comp.status === "healthy";
  });

  // Determine overall status
  let status: ComponentStatus;
  if (!criticalHealthy) {
    status = "unhealthy"; // Critical components down
  } else if (!hasWorkingProvider) {
    status = "degraded"; // No data providers, but app runs
  } else if (unhealthyCount > 0) {
    status = "degraded"; // Some components down, but functional
  } else {
    status = "healthy"; // All good
  }

  return {
    status,
    uptime: Date.now() - startTime,
    components,
    circuitBreakers: getAllCircuitBreakerStats(),
    lastHealthCheck: Date.now(),
  };
}

/**
 * Record a failure for a component
 */
export function recordFailure(componentId: string): number {
  const current = componentFailures.get(componentId) || 0;
  const newCount = current + 1;
  componentFailures.set(componentId, newCount);

  // Check if we need to trigger healing
  if (newCount >= UNHEALTHY_THRESHOLD) {
    triggerHealing(componentId, newCount);
  }

  return newCount;
}

/**
 * Record a success for a component (resets failure count)
 */
export function recordSuccess(componentId: string): void {
  componentFailures.set(componentId, 0);
}

/**
 * Get failure count for a component
 */
export function getFailureCount(componentId: string): number {
  return componentFailures.get(componentId) || 0;
}

// ============================================
// Healing Actions
// ============================================

/**
 * Trigger healing for a component
 */
async function triggerHealing(
  componentId: string,
  failureCount: number,
): Promise<void> {
  logger.warn(
    "HealthManager",
    `Component ${componentId} has ${failureCount} failures, attempting healing`,
  );

  // Check for fatal threshold first
  if (failureCount >= FATAL_THRESHOLD) {
    logger.error(
      "HealthManager",
      `FATAL: ${componentId} exceeded ${FATAL_THRESHOLD} failures - triggering restart`,
    );
    if (onFatalCallback) {
      onFatalCallback();
    }
    return;
  }

  // Try component-specific healing
  const healAction = healingActions.get(componentId);
  if (healAction) {
    try {
      const success = await healAction();
      if (success) {
        logger.info("HealthManager", `Healing successful for ${componentId}`);
        componentFailures.set(componentId, 0);
      } else {
        logger.warn("HealthManager", `Healing failed for ${componentId}`);
      }
    } catch (error) {
      logger.error("HealthManager", `Healing error for ${componentId}:`, error);
    }
  }
}

/**
 * Manually trigger healing for a component
 */
export async function healComponent(componentId: string): Promise<boolean> {
  const healAction = healingActions.get(componentId);
  if (!healAction) {
    logger.warn(
      "HealthManager",
      `No healing action registered for ${componentId}`,
    );
    return false;
  }

  try {
    const success = await healAction();
    if (success) {
      componentFailures.set(componentId, 0);
    }
    return success;
  } catch (error) {
    logger.error(
      "HealthManager",
      `Manual healing failed for ${componentId}:`,
      error,
    );
    return false;
  }
}

/**
 * Heal all unhealthy components
 */
export async function healAll(): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};

  for (const [id] of healingActions) {
    const health = getComponentHealth(id);
    if (health.status === "unhealthy" || health.status === "degraded") {
      results[id] = await healComponent(id);
    }
  }

  return results;
}

// ============================================
// Background Health Monitoring
// ============================================

/**
 * Start background health monitoring
 */
export function startHealthMonitoring(): void {
  if (healthCheckInterval) return;

  // Register memory health provider on first start
  if (!healthProviders.has("memory")) {
    registerMemoryHealthProvider();
  }

  logger.info("HealthManager", "Starting background health monitoring");

  let lastLoggedStatus: string | null = null;

  healthCheckInterval = setInterval(() => {
    const health = getSystemHealth();

    // Only log when status changes (avoid spam)
    if (health.status !== "healthy" && health.status !== lastLoggedStatus) {
      const unhealthyComponents = Object.entries(health.components)
        .filter(([, h]) => h.status !== "healthy")
        .map(([id]) => id);

      const healthyComponents = Object.entries(health.components)
        .filter(([, h]) => h.status === "healthy")
        .map(([id]) => id);

      // More informative message
      if (healthyComponents.length > 0) {
        logger.info(
          "HealthManager",
          `Degraded: [${unhealthyComponents.join(", ")}] down, continuing with [${healthyComponents.join(", ")}]`,
        );
      } else {
        logger.warn(
          "HealthManager",
          `System ${health.status}: [${unhealthyComponents.join(", ")}]`,
        );
      }
      lastLoggedStatus = health.status;
    } else if (health.status === "healthy" && lastLoggedStatus !== "healthy") {
      logger.info("HealthManager", "All providers healthy");
      lastLoggedStatus = "healthy";
    }

    // Check circuit breakers
    const openCircuits = Object.entries(health.circuitBreakers)
      .filter(([, stats]) => stats.state === "open")
      .map(([id]) => id);

    if (openCircuits.length > 0) {
      logger.warn(
        "HealthManager",
        `Open circuit breakers: [${openCircuits.join(", ")}]`,
      );
    }
  }, HEALTH_CHECK_INTERVAL);
}

/**
 * Stop background health monitoring
 */
export function stopHealthMonitoring(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
    logger.info("HealthManager", "Stopped background health monitoring");
  }
}

// ============================================
// Memory Monitoring
// ============================================

const MEMORY_DEGRADED_MB = 500;
const MEMORY_UNHEALTHY_MB = 750;

/**
 * Get current memory stats with alert threshold
 */
export function getMemoryStats(): {
  heapUsedMB: number;
  rssMB: number;
  heapPct: number;
  alert: string | null;
} {
  const mem = process.memoryUsage();
  const heapUsedMB = Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100;
  const rssMB = Math.round((mem.rss / 1024 / 1024) * 100) / 100;
  const heapPct =
    mem.heapTotal > 0
      ? Math.round((mem.heapUsed / mem.heapTotal) * 10000) / 100
      : 0;

  let alert: string | null = null;
  if (rssMB > MEMORY_UNHEALTHY_MB) {
    alert = `CRITICAL: Very high memory usage (${rssMB}MB RSS > ${MEMORY_UNHEALTHY_MB}MB)`;
  } else if (rssMB > MEMORY_DEGRADED_MB) {
    alert = `WARNING: High memory usage (${rssMB}MB RSS > ${MEMORY_DEGRADED_MB}MB)`;
  }

  return { heapUsedMB, rssMB, heapPct, alert };
}

/**
 * Register the memory health provider.
 * Call this during app startup (e.g., from startHealthMonitoring).
 */
function registerMemoryHealthProvider(): void {
  registerHealthProvider("memory", () => {
    const { rssMB, heapPct, alert } = getMemoryStats();

    let status: ComponentStatus;
    if (rssMB > MEMORY_UNHEALTHY_MB) {
      status = "unhealthy";
    } else if (rssMB > MEMORY_DEGRADED_MB) {
      status = "degraded";
    } else {
      status = "healthy";
    }

    return {
      status,
      lastCheck: Date.now(),
      consecutiveFailures: 0,
      details: {
        rssMB,
        heapPct,
        alert,
      },
    };
  });
}

// ============================================
// Utility Functions
// ============================================

/**
 * Convert failure count to status
 */
export function failureCountToStatus(count: number): ComponentStatus {
  if (count >= UNHEALTHY_THRESHOLD) return "unhealthy";
  if (count >= DEGRADED_THRESHOLD) return "degraded";
  return "healthy";
}

/**
 * Get uptime in human-readable format
 */
export function getUptimeString(): string {
  const uptime = Date.now() - startTime;
  const hours = Math.floor(uptime / 3600000);
  const minutes = Math.floor((uptime % 3600000) / 60000);
  const seconds = Math.floor((uptime % 60000) / 1000);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
