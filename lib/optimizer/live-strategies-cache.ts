/**
 * In-memory cache of live (status='live') optimization strategies.
 *
 * The value-detector consults this on every detection tick — hammering
 * Postgres for every detected bet would be catastrophic. Cache TTL is 60s,
 * with explicit invalidation on status changes via the API mutation.
 *
 * Pattern matches lib/util/singleton — survives HMR + module-context
 * duplication under Turbopack.
 */

import { singleton } from "../util/singleton";
import {
  listLiveStrategies,
  setStrategyStatus as setStatusInRepo,
  type OptimizationStrategyRow,
  type StrategyStatus,
} from "./strategies";

const TTL_MS = 60_000;

interface CacheState {
  strategies: OptimizationStrategyRow[];
  expiresAt: number;
  refreshing: Promise<void> | null;
}

const state = singleton<CacheState>("optimizer:live-strategies-cache", () => ({
  strategies: [],
  expiresAt: 0,
  refreshing: null,
}));

async function refresh(): Promise<void> {
  if (state.refreshing) return state.refreshing;
  state.refreshing = (async () => {
    try {
      state.strategies = await listLiveStrategies();
      state.expiresAt = Date.now() + TTL_MS;
    } finally {
      state.refreshing = null;
    }
  })();
  return state.refreshing;
}

/**
 * Returns the current set of live strategies. May trigger a background
 * refresh if the cache is stale; returns the previous value while the
 * refresh is in flight (eventually-consistent — fine for value-detection).
 */
export async function getLiveStrategies(): Promise<OptimizationStrategyRow[]> {
  if (Date.now() > state.expiresAt) {
    // Fire-and-forget refresh; serve stale on first call.
    void refresh();
  }
  // First-ever call needs the synchronous wait.
  if (state.expiresAt === 0) {
    await refresh();
  }
  return state.strategies;
}

/**
 * Manually invalidate the cache. Called from the API mutation when a
 * strategy's status changes — ensures the next detection tick sees the
 * change immediately rather than waiting up to 60s.
 */
export function invalidateLiveStrategiesCache(): void {
  state.expiresAt = 0;
}

/** Re-exported for the API route's convenience (single import surface). */
export async function setStrategyStatus(
  id: string,
  status: StrategyStatus,
): Promise<OptimizationStrategyRow | null> {
  return setStatusInRepo(id, status);
}
