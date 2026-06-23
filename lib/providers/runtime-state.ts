
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


export function isProviderRuntimeEnabled(id: string): boolean {
  const key = id as ProviderKey;
  const meta = PROVIDER_REGISTRY[key];
  if (!meta) return false;
  return !state().disabled.has(key);
}

export function getRuntimeDisabledProviders(): Set<ProviderKey> {
  return new Set(state().disabled);
}

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

export function setDisabledProviders(ids: ProviderKey[]): void {
  const s = state();
  s.disabled = new Set(ids);
  saveToDisk();
}

export function getRuntimeEnabledProviderIds(): ProviderKey[] {
  return PROVIDER_IDS.filter((id) => isProviderRuntimeEnabled(id));
}

export function getRuntimeSoftProviders(): ProviderKey[] {
  return PROVIDER_IDS.filter(
    (id) =>
      isProviderRuntimeEnabled(id) &&
      PROVIDER_REGISTRY[id].bookmakerType === "soft",
  );
}

export function getRuntimeSharpProviders(): ProviderKey[] {
  return PROVIDER_IDS.filter(
    (id) =>
      isProviderRuntimeEnabled(id) &&
      PROVIDER_REGISTRY[id].bookmakerType === "sharp",
  );
}
