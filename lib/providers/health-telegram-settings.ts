import * as fs from "fs";
import * as path from "path";
import { logger } from "../shared/logger";

const FILE = path.join(
  process.cwd(),
  "data",
  "config",
  "provider-health-telegram.json",
);

interface PersistedState {
  version: number;
  enabled: boolean;
  updatedAt: string;
}

interface ProviderHealthTelegramSettings {
  enabled: boolean;
  updatedAt: string | null;
}

declare global {
  var __providerHealthTelegramSettings:
    | (ProviderHealthTelegramSettings & { loaded: boolean })
    | undefined;
}

function state() {
  if (!globalThis.__providerHealthTelegramSettings) {
    globalThis.__providerHealthTelegramSettings = {
      enabled: false,
      updatedAt: null,
      loaded: false,
    };
  }
  if (!globalThis.__providerHealthTelegramSettings.loaded) loadFromDisk();
  return globalThis.__providerHealthTelegramSettings;
}

function loadFromDisk(): void {
  const s = globalThis.__providerHealthTelegramSettings!;
  s.loaded = true;
  try {
    if (!fs.existsSync(FILE)) return;
    const raw = fs.readFileSync(FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    s.enabled = parsed.enabled === true;
    s.updatedAt =
      typeof parsed.updatedAt === "string" ? parsed.updatedAt : null;
    logger.info(
      "ProviderHealthTelegramSettings",
      `Loaded: ${s.enabled ? "enabled" : "disabled"}`,
    );
  } catch (err) {
    logger.warn(
      "ProviderHealthTelegramSettings",
      `Failed to load: ${(err as Error).message}`,
    );
  }
}

function saveToDisk(): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const s = state();
    const updatedAt = new Date().toISOString();
    const body: PersistedState = {
      version: 1,
      enabled: s.enabled,
      updatedAt,
    };
    fs.writeFileSync(FILE, JSON.stringify(body, null, 2));
    s.updatedAt = updatedAt;
  } catch (err) {
    logger.error(
      "ProviderHealthTelegramSettings",
      `Failed to save: ${(err as Error).message}`,
    );
  }
}

export function getProviderHealthTelegramSettings(): ProviderHealthTelegramSettings {
  const s = state();
  return {
    enabled: s.enabled,
    updatedAt: s.updatedAt,
  };
}

export function isProviderHealthTelegramEnabled(): boolean {
  return state().enabled;
}

export function setProviderHealthTelegramEnabled(
  enabled: boolean,
): ProviderHealthTelegramSettings {
  const s = state();
  s.enabled = enabled;
  saveToDisk();
  logger.info(
    "ProviderHealthTelegramSettings",
    `Provider health Telegram alerts ${enabled ? "enabled" : "disabled"}`,
  );
  return getProviderHealthTelegramSettings();
}
