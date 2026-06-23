import * as fs from "node:fs";
import * as path from "node:path";
import { listBettingProviders } from "./registry";

const FILE = path.join("sessions", "betting", "auto-place.json");

export interface AutoPlaceConfig {
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
