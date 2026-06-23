
import {
  getAllCircuitBreakerStats,
  type CircuitBreakerStats,
} from "./circuit-breaker";
import { logger } from "./logger";
import { singleton } from "@/lib/util/singleton";
import { getDataHealthProviderIds } from "../providers/registry";


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

type HealthProvider = () => ComponentHealth;
type HealingAction = () => Promise<boolean>;


const hmState = singleton("health-manager:state", () => ({
  startTime: Date.now(),
  healthProviders: new Map<string, HealthProvider>(),
  healingActions: new Map<string, HealingAction>(),
  componentFailures: new Map<string, number>(),
  onFatalCallback: null as (() => void) | null,
  healthCheckInterval: null as NodeJS.Timeout | null,
}));

const DEGRADED_THRESHOLD = 3;
const UNHEALTHY_THRESHOLD = 5;
const FATAL_THRESHOLD = 10;

const HEALTH_CHECK_INTERVAL = 30000;


export function registerHealthProvider(
  componentId: string,
  provider: HealthProvider,
): void {
  hmState.healthProviders.set(componentId, provider);
  hmState.componentFailures.set(componentId, 0);
}

export function registerHealingAction(
  componentId: string,
  action: HealingAction,
): void {
  hmState.healingActions.set(componentId, action);
}

export function onFatalFailure(callback: () => void): void {
  hmState.onFatalCallback = callback;
}


export function getComponentHealth(componentId: string): ComponentHealth {
  const provider = hmState.healthProviders.get(componentId);
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
      consecutiveFailures: hmState.componentFailures.get(componentId) || 0,
      details: {
        error: error instanceof Error ? error.message : "Unknown error",
      },
    };
  }
}

export function getSystemHealth(): SystemHealth {
  const components: Record<string, ComponentHealth> = {};
  let unhealthyCount = 0;

  const CRITICAL = ["scheduler"];
  const dataProviders = getDataHealthProviderIds();

  for (const [id] of hmState.healthProviders) {
    const health = getComponentHealth(id);
    components[id] = health;

    if (health.status === "unhealthy") {
      unhealthyCount++;
    }
  }

  const criticalHealthy = CRITICAL.every((id) => {
    const comp = components[id];
    return comp && comp.status !== "unhealthy";
  });

  const hasWorkingProvider = dataProviders.some((id) => {
    const comp = components[id];
    return comp && comp.status === "healthy";
  });

  let status: ComponentStatus;
  if (!criticalHealthy) {
    status = "unhealthy";
  } else if (!hasWorkingProvider) {
    status = "degraded";
  } else if (unhealthyCount > 0) {
    status = "degraded";
  } else {
    status = "healthy";
  }

  return {
    status,
    uptime: Date.now() - hmState.startTime,
    components,
    circuitBreakers: getAllCircuitBreakerStats(),
    lastHealthCheck: Date.now(),
  };
}

export function recordFailure(componentId: string): number {
  const current = hmState.componentFailures.get(componentId) || 0;
  const newCount = current + 1;
  hmState.componentFailures.set(componentId, newCount);

  if (newCount >= UNHEALTHY_THRESHOLD) {
    triggerHealing(componentId, newCount);
  }

  return newCount;
}

export function recordSuccess(componentId: string): void {
  hmState.componentFailures.set(componentId, 0);
}

export function getFailureCount(componentId: string): number {
  return hmState.componentFailures.get(componentId) || 0;
}


async function triggerHealing(
  componentId: string,
  failureCount: number,
): Promise<void> {
  logger.warn(
    "HealthManager",
    `Component ${componentId} has ${failureCount} failures, attempting healing`,
  );

  if (failureCount >= FATAL_THRESHOLD) {
    logger.error(
      "HealthManager",
      `FATAL: ${componentId} exceeded ${FATAL_THRESHOLD} failures - triggering restart`,
    );
    if (hmState.onFatalCallback) {
      hmState.onFatalCallback();
    }
    return;
  }

  const healAction = hmState.healingActions.get(componentId);
  if (healAction) {
    try {
      const success = await healAction();
      if (success) {
        logger.info("HealthManager", `Healing successful for ${componentId}`);
        hmState.componentFailures.set(componentId, 0);
      } else {
        logger.warn("HealthManager", `Healing failed for ${componentId}`);
      }
    } catch (error) {
      logger.error("HealthManager", `Healing error for ${componentId}:`, error);
    }
  }
}

export async function healComponent(componentId: string): Promise<boolean> {
  const healAction = hmState.healingActions.get(componentId);
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
      hmState.componentFailures.set(componentId, 0);
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

export async function healAll(): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};

  for (const [id] of hmState.healingActions) {
    const health = getComponentHealth(id);
    if (health.status === "unhealthy" || health.status === "degraded") {
      results[id] = await healComponent(id);
    }
  }

  return results;
}


export function startHealthMonitoring(): void {
  if (hmState.healthCheckInterval) return;

  if (!hmState.healthProviders.has("memory")) {
    registerMemoryHealthProvider();
  }

  logger.info("HealthManager", "Starting background health monitoring");

  let lastLoggedStatus: string | null = null;

  hmState.healthCheckInterval = setInterval(() => {
    const health = getSystemHealth();

    if (health.status !== "healthy" && health.status !== lastLoggedStatus) {
      const unhealthyComponents = Object.entries(health.components)
        .filter(([, h]) => h.status !== "healthy")
        .map(([id]) => id);

      const healthyComponents = Object.entries(health.components)
        .filter(([, h]) => h.status === "healthy")
        .map(([id]) => id);

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

export function stopHealthMonitoring(): void {
  if (hmState.healthCheckInterval) {
    clearInterval(hmState.healthCheckInterval);
    hmState.healthCheckInterval = null;
    logger.info("HealthManager", "Stopped background health monitoring");
  }
}


const MEMORY_DEGRADED_MB = 500;
const MEMORY_UNHEALTHY_MB = 750;

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


export function failureCountToStatus(count: number): ComponentStatus {
  if (count >= UNHEALTHY_THRESHOLD) return "unhealthy";
  if (count >= DEGRADED_THRESHOLD) return "degraded";
  return "healthy";
}

export function getUptimeString(): string {
  const uptime = Date.now() - hmState.startTime;
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
