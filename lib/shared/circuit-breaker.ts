/**
 * Per-Provider Circuit Breakers
 *
 * Uses cockatiel for composable resilience policies:
 * - Circuit breaker: open after 3 consecutive failures, half-open after 30s
 * - Timeout: Pinnacle 30s, others 15s
 * - Retry: 2 retries, exponential backoff starting at 1s
 * - Policies are composed via wrap() so each provider is isolated
 *
 * @see https://github.com/connor4312/cockatiel
 */

import {
  ConsecutiveBreaker,
  ExponentialBackoff,
  retry,
  handleAll,
  circuitBreaker,
  timeout,
  TimeoutStrategy,
  wrap,
  CircuitState,
  type CircuitBreakerPolicy,
  type IPolicy,
} from "cockatiel";
import { logger } from "./logger";

// ============================================
// Types
// ============================================

export interface CircuitBreakerStats {
  state: "closed" | "open" | "half-open";
  failures: number;
  successes: number;
  fallbacks: number;
  timeouts: number;
  cacheHits: number;
  cacheMisses: number;
  percentile99: number;
}

// ============================================
// Per-provider timeout configuration (ms)
// ============================================

const PROVIDER_TIMEOUTS: Record<string, number> = {
  pinnacle: 30_000,
  betconstruct: 15_000,
  "ninewickets-exchange": 15_000,
  "ninewickets-sportsbook": 15_000,
};

const DEFAULT_TIMEOUT = 15_000;

// ============================================
// Internal tracking for stats
// ============================================

interface ProviderTracking {
  failures: number;
  successes: number;
  timeouts: number;
  circuitBreaker: CircuitBreakerPolicy;
  composedPolicy: IPolicy;
}

const providers = new Map<string, ProviderTracking>();

// ============================================
// Policy Factory
// ============================================

function circuitStateToString(
  state: CircuitState,
): "closed" | "open" | "half-open" {
  switch (state) {
    case CircuitState.Closed:
      return "closed";
    case CircuitState.Open:
      return "open";
    case CircuitState.HalfOpen:
      return "half-open";
    default:
      return "closed";
  }
}

/**
 * Create the composed policy for a provider.
 * Order: retry -> circuitBreaker -> timeout
 * (retry wraps CB which wraps timeout, so retries happen outside the CB)
 */
function createProviderPolicy(providerId: string): ProviderTracking {
  const timeoutMs = PROVIDER_TIMEOUTS[providerId] ?? DEFAULT_TIMEOUT;

  // Retry: 2 retries with exponential backoff starting at 1s
  const retryPolicy = retry(handleAll, {
    maxAttempts: 2,
    backoff: new ExponentialBackoff({ initialDelay: 1000 }),
  });

  // Circuit breaker: open after 3 consecutive failures, half-open after 30s
  const cbPolicy = circuitBreaker(handleAll, {
    halfOpenAfter: 30_000,
    breaker: new ConsecutiveBreaker(3),
  });

  // Timeout per request
  const timeoutPolicy = timeout(timeoutMs, TimeoutStrategy.Aggressive);

  // Compose: retry wraps circuit breaker wraps timeout
  const composed = wrap(retryPolicy, cbPolicy, timeoutPolicy);

  const tracking: ProviderTracking = {
    failures: 0,
    successes: 0,
    timeouts: 0,
    circuitBreaker: cbPolicy,
    composedPolicy: composed,
  };

  // Track state changes
  cbPolicy.onStateChange((state) => {
    if (state === CircuitState.Open) {
      logger.warn("CircuitBreaker", `[${providerId}] OPENED - failing fast`);
    } else if (state === CircuitState.HalfOpen) {
      logger.info(
        "CircuitBreaker",
        `[${providerId}] HALF-OPEN - testing recovery`,
      );
    } else if (state === CircuitState.Closed) {
      logger.info("CircuitBreaker", `[${providerId}] CLOSED - recovered`);
    }
  });

  // Track successes via the CB policy
  cbPolicy.onSuccess(() => {
    tracking.successes++;
  });

  cbPolicy.onFailure(() => {
    tracking.failures++;
  });

  // Track timeouts
  timeoutPolicy.onTimeout(() => {
    tracking.timeouts++;
    logger.debug(
      "CircuitBreaker",
      `[${providerId}] Request timed out (${timeoutMs}ms)`,
    );
  });

  return tracking;
}

/**
 * Get or create the composed resilience policy for a provider.
 * Returns an object with an `execute` method.
 */
export function getProviderPolicy(providerId: string): {
  execute: <T>(fn: () => Promise<T>) => Promise<T>;
} {
  let tracking = providers.get(providerId);
  if (!tracking) {
    tracking = createProviderPolicy(providerId);
    providers.set(providerId, tracking);
  }

  const policy = tracking.composedPolicy;
  return {
    execute: <T>(fn: () => Promise<T>) => policy.execute(fn) as Promise<T>,
  };
}

// ============================================
// Legacy API (backward-compatible)
// ============================================

/**
 * Execute a function through the provider's circuit breaker policy
 */
export async function withCircuitBreaker<T>(
  providerId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const policy = getProviderPolicy(providerId);
  return policy.execute(fn);
}

// ============================================
// Stats & Health
// ============================================

/**
 * Get stats for a specific circuit breaker
 */
export function getCircuitBreakerStats(
  providerId: string,
): CircuitBreakerStats | null {
  const tracking = providers.get(providerId);
  if (!tracking) return null;

  return {
    state: circuitStateToString(tracking.circuitBreaker.state),
    failures: tracking.failures,
    successes: tracking.successes,
    fallbacks: 0,
    timeouts: tracking.timeouts,
    cacheHits: 0,
    cacheMisses: 0,
    percentile99: 0,
  };
}

/**
 * Get stats for all circuit breakers
 */
export function getAllCircuitBreakerStats(): Record<
  string,
  CircuitBreakerStats
> {
  const result: Record<string, CircuitBreakerStats> = {};

  for (const [id, tracking] of providers) {
    result[id] = {
      state: circuitStateToString(tracking.circuitBreaker.state),
      failures: tracking.failures,
      successes: tracking.successes,
      fallbacks: 0,
      timeouts: tracking.timeouts,
      cacheHits: 0,
      cacheMisses: 0,
      percentile99: 0,
    };
  }

  return result;
}

/**
 * Check if a circuit breaker is healthy (closed or half-open)
 */
export function isCircuitHealthy(providerId: string): boolean {
  const tracking = providers.get(providerId);
  if (!tracking) return true; // No breaker = hasn't been used yet
  return tracking.circuitBreaker.state !== CircuitState.Open;
}

/**
 * Reset a specific circuit breaker (manual recovery)
 */
export function resetCircuitBreaker(providerId: string): void {
  const tracking = providers.get(providerId);
  if (tracking) {
    // Remove and recreate the provider policy to reset all state
    providers.delete(providerId);
    logger.info("CircuitBreaker", `[${providerId}] Reset`);
  }
}

/**
 * Manually close a circuit breaker (force recovery)
 * @deprecated Use resetCircuitBreaker instead
 */
export function closeCircuit(providerId: string): void {
  resetCircuitBreaker(providerId);
}

/**
 * Manually open a circuit breaker (force failure)
 * Note: cockatiel doesn't support manually opening; reset instead
 * @deprecated
 */
export function openCircuit(providerId: string): void {
  logger.warn(
    "CircuitBreaker",
    `[${providerId}] Manual open not supported in cockatiel, use resetCircuitBreaker`,
  );
}

/**
 * Clear all circuit breakers (for testing)
 */
export function clearCircuitBreakers(): void {
  providers.clear();
}
