
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
import { getProviderTimeoutMs } from "../providers/registry";


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


const DEFAULT_TIMEOUT = 15_000;


interface ProviderTracking {
  failures: number;
  successes: number;
  timeouts: number;
  circuitBreaker: CircuitBreakerPolicy;
  composedPolicy: IPolicy;
}

const providers = new Map<string, ProviderTracking>();


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

function createProviderPolicy(providerId: string): ProviderTracking {
  const timeoutMs = getProviderTimeoutMs(providerId) ?? DEFAULT_TIMEOUT;

  const retryPolicy = retry(handleAll, {
    maxAttempts: 2,
    backoff: new ExponentialBackoff({ initialDelay: 1000 }),
  });

  const cbPolicy = circuitBreaker(handleAll, {
    halfOpenAfter: 30_000,
    breaker: new ConsecutiveBreaker(3),
  });

  const timeoutPolicy = timeout(timeoutMs, TimeoutStrategy.Aggressive);

  const composed = wrap(retryPolicy, cbPolicy, timeoutPolicy);

  const tracking: ProviderTracking = {
    failures: 0,
    successes: 0,
    timeouts: 0,
    circuitBreaker: cbPolicy,
    composedPolicy: composed,
  };

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

  cbPolicy.onSuccess(() => {
    tracking.successes++;
  });

  cbPolicy.onFailure(() => {
    tracking.failures++;
  });

  timeoutPolicy.onTimeout(() => {
    tracking.timeouts++;
    logger.debug(
      "CircuitBreaker",
      `[${providerId}] Request timed out (${timeoutMs}ms)`,
    );
  });

  return tracking;
}

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


export async function withCircuitBreaker<T>(
  providerId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const policy = getProviderPolicy(providerId);
  return policy.execute(fn);
}


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

export function isCircuitHealthy(providerId: string): boolean {
  const tracking = providers.get(providerId);
  if (!tracking) return true;
  return tracking.circuitBreaker.state !== CircuitState.Open;
}

export function resetCircuitBreaker(providerId: string): void {
  const tracking = providers.get(providerId);
  if (tracking) {
    providers.delete(providerId);
    logger.info("CircuitBreaker", `[${providerId}] Reset`);
  }
}

export function closeCircuit(providerId: string): void {
  resetCircuitBreaker(providerId);
}

export function openCircuit(providerId: string): void {
  logger.warn(
    "CircuitBreaker",
    `[${providerId}] Manual open not supported in cockatiel, use resetCircuitBreaker`,
  );
}

export function clearCircuitBreakers(): void {
  providers.clear();
}
