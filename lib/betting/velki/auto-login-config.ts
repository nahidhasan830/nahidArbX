/**
 * Auto-login kill switch for the Velki session manager.
 *
 * Velki, like 9W, enforces one-active-session-per-account at the
 * provider tier. When the operator is logged into Velki manually on
 * their phone or another device, our background `getSession()` would
 * silently kick them off (the provider returns
 * `{"status":"9999","status_msg":"You have been logged off..."}`).
 *
 * The dashboard exposes a toggle: while auto-login is OFF,
 * {@link getSession} surfaces a clear error instead of running the
 * 3-step REST capture chain. While ON (default), the session manager
 * re-captures on demand.
 *
 * The flag also gates the "balance=0 → auto-recapture" policy in the
 * overview/accounts routes — if the user has paused auto-login we
 * leave the balance reading alone instead of forcing a fresh JSESSIONID.
 *
 * Storage: `sessions/velki/auto-login.json` (gitignored, mirrors 9W).
 */
import * as fs from "fs";
import * as path from "path";

const CONFIG_PATH = path.join("sessions", "velki", "auto-login.json");

export interface VelkiAutoLoginConfig {
  enabled: boolean;
  reason: string | null;
  updatedAt: string;
}

const DEFAULT_CONFIG: VelkiAutoLoginConfig = {
  enabled: true,
  reason: null,
  updatedAt: new Date(0).toISOString(),
};

export function getVelkiAutoLoginConfig(): VelkiAutoLoginConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<VelkiAutoLoginConfig>;
    return {
      enabled: parsed.enabled ?? DEFAULT_CONFIG.enabled,
      reason: parsed.reason ?? null,
      updatedAt: parsed.updatedAt ?? DEFAULT_CONFIG.updatedAt,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function isVelkiAutoLoginEnabled(): boolean {
  return getVelkiAutoLoginConfig().enabled;
}

export function setVelkiAutoLoginConfig(
  enabled: boolean,
  reason: string | null = null,
): VelkiAutoLoginConfig {
  const config: VelkiAutoLoginConfig = {
    enabled,
    reason,
    updatedAt: new Date().toISOString(),
  };
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  return config;
}

export class VelkiAutoLoginDisabledError extends Error {
  constructor(reason: string | null) {
    super(
      reason
        ? `Velki auto-login is disabled by the operator (${reason}). ` +
            "Turn it back on from the dashboard to refresh the session."
        : "Velki auto-login is disabled by the operator. " +
            "Turn it back on from the dashboard to refresh the session.",
    );
    this.name = "VelkiAutoLoginDisabledError";
  }
}
