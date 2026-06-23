import * as fs from "fs";
import * as path from "path";

const CONFIG_PATH = path.join("sessions", "9wkts", "auto-login.json");

export interface AutoLoginConfig {
  enabled: boolean;
  reason: string | null;
  updatedAt: string;
}

const DEFAULT_CONFIG: AutoLoginConfig = {
  enabled: true,
  reason: null,
  updatedAt: new Date(0).toISOString(),
};

export function getAutoLoginConfig(): AutoLoginConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<AutoLoginConfig>;
    return {
      enabled: parsed.enabled ?? DEFAULT_CONFIG.enabled,
      reason: parsed.reason ?? null,
      updatedAt: parsed.updatedAt ?? DEFAULT_CONFIG.updatedAt,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function isAutoLoginEnabled(): boolean {
  return getAutoLoginConfig().enabled;
}

export function setAutoLoginConfig(
  enabled: boolean,
  reason: string | null = null,
): AutoLoginConfig {
  const config: AutoLoginConfig = {
    enabled,
    reason,
    updatedAt: new Date().toISOString(),
  };
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  return config;
}

export class AutoLoginDisabledError extends Error {
  constructor(reason: string | null) {
    super(
      reason
        ? `Auto-login is disabled by the operator (${reason}). ` +
            "Turn it back on from the dashboard to refresh the session."
        : "Auto-login is disabled by the operator. " +
            "Turn it back on from the dashboard to refresh the session.",
    );
    this.name = "AutoLoginDisabledError";
  }
}
