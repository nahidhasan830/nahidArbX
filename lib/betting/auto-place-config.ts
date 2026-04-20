/**
 * Per-provider auto-place configuration.
 *
 * Persisted to `sessions/betting/auto-place.json` (gitignored, same
 * pattern as the 9wkts session). Defaults to OFF for every provider
 * so a fresh install never auto-places without explicit opt-in.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { listBettingProviders } from "./registry";

const FILE = path.join("sessions", "betting", "auto-place.json");

export interface AutoPlaceConfig {
  /** provider id -> auto-place enabled. Missing key = disabled. */
  enabled: Record<string, boolean>;
}

export function readAutoPlaceConfig(): AutoPlaceConfig {
  try {
    if (!fs.existsSync(FILE)) return { enabled: {} };
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as AutoPlaceConfig;
  } catch {
    return { enabled: {} };
  }
}

export function writeAutoPlaceConfig(config: AutoPlaceConfig) {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(config, null, 2));
}

export function isAutoPlaceEnabled(providerId: string): boolean {
  return readAutoPlaceConfig().enabled[providerId] === true;
}

export function setAutoPlaceEnabled(providerId: string, enabled: boolean) {
  const cfg = readAutoPlaceConfig();
  cfg.enabled[providerId] = enabled;
  writeAutoPlaceConfig(cfg);
}

/**
 * Snapshot of the toggle state for every provider in the registry.
 * Used by the dashboard to render one switch per provider — even if
 * the provider has never been toggled before it appears with `false`.
 */
export function listAutoPlaceStates(): {
  provider: string;
  providerDisplayName: string;
  enabled: boolean;
}[] {
  const cfg = readAutoPlaceConfig();
  return listBettingProviders().map((p) => ({
    provider: p.providerId,
    providerDisplayName: p.providerDisplayName,
    enabled: cfg.enabled[p.providerId] === true,
  }));
}
