/**
 * Provider Runtime State
 *
 * Persists which providers are currently enabled (backend-effective) to disk.
 * Used by the adapter registry, odds fetcher, and match-review AI route to
 * skip all work for disabled providers — including fixture fetch, odds fetch,
 * and AI analysis. The UI provider dropdown drives this state.
 *
 * A provider is considered enabled when:
 *   1. Its static `PROVIDER_REGISTRY[id].enabled` flag is true (compile-time),
 *   2. AND it is NOT listed in the disabled-providers set on disk.
 *
 * Default: the disabled set is empty, so behavior is unchanged until the user
 * actively disables a provider.
 */

import * as fs from "fs";
import * as path from "path";
import { PROVIDER_IDS, type ProviderKey, PROVIDER_REGISTRY } from "./registry";
import { logger } from "../shared/logger";

const FILE = path.join(
  process.cwd(),
  "data",
  "config",
  "enabled-providers.json",
);

interface PersistedState {
  version: number;
  /** Providers the user has explicitly disabled at runtime */
  disabled: ProviderKey[];
  updatedAt: string;
}

declare global {
  var __providerRuntimeState:
    | {
        disabled: Set<ProviderKey>;
        loaded: boolean;
      }
    | undefined;
}

function state() {
  if (!globalThis.__providerRuntimeState) {
    globalThis.__providerRuntimeState = {
      disabled: new Set(),
      loaded: false,
    };
  }
  if (!globalThis.__providerRuntimeState.loaded) loadFromDisk();
  return globalThis.__providerRuntimeState;
}

function loadFromDisk() {
  const s = globalThis.__providerRuntimeState!;
  s.loaded = true;
  try {
    if (!fs.existsSync(FILE)) return;
    const raw = fs.readFileSync(FILE, "utf-8");
    const parsed: PersistedState = JSON.parse(raw);
    s.disabled = new Set(parsed.disabled || []);
    logger.info(
      "ProviderRuntimeState",
      `Loaded: ${s.disabled.size} disabled provider(s)`,
    );
  } catch (err) {
    logger.warn(
      "ProviderRuntimeState",
      `Failed to load: ${(err as Error).message}`,
    );
  }
}

function saveToDisk() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const s = state();
    const body: PersistedState = {
      version: 1,
      disabled: Array.from(s.disabled),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(FILE, JSON.stringify(body, null, 2));
  } catch (err) {
    logger.error(
      "ProviderRuntimeState",
      `Failed to save: ${(err as Error).message}`,
    );
  }
}

// ============================================
// Public API
// ============================================

/**
 * Is this provider currently enabled (static flag AND not runtime-disabled)?
 */
export function isProviderRuntimeEnabled(id: string): boolean {
  const key = id as ProviderKey;
  const meta = PROVIDER_REGISTRY[key];
  if (!meta?.enabled) return false;
  return !state().disabled.has(key);
}

/**
 * Get the set of runtime-disabled provider IDs.
 */
export function getRuntimeDisabledProviders(): Set<ProviderKey> {
  return new Set(state().disabled);
}

/**
 * Set a provider enabled/disabled at runtime. Persisted to disk.
 * Returns the new disabled set for convenience.
 */
export function setProviderRuntimeEnabled(
  id: ProviderKey,
  enabled: boolean,
): Set<ProviderKey> {
  const s = state();
  if (enabled) {
    s.disabled.delete(id);
  } else {
    s.disabled.add(id);
  }
  saveToDisk();
  logger.info(
    "ProviderRuntimeState",
    `${id} → ${enabled ? "enabled" : "disabled"} (disabled now: ${[...s.disabled].join(", ") || "none"})`,
  );
  return new Set(s.disabled);
}

/**
 * Bulk set the disabled set (overwrites current). Useful for syncing from UI.
 */
export function setDisabledProviders(ids: ProviderKey[]): void {
  const s = state();
  s.disabled = new Set(ids);
  saveToDisk();
}

/**
 * Enumerate runtime-enabled provider IDs.
 */
export function getRuntimeEnabledProviderIds(): ProviderKey[] {
  return PROVIDER_IDS.filter((id) => isProviderRuntimeEnabled(id));
}
