/**
 * Auto-login kill switch for the 9W session manager.
 *
 * 9W enforces one-active-session-per-account. When the user is
 * manually logged in on their own device, running Playwright
 * auto-login from our app would silently kick them off (the server
 * responds with `{"status":"1001","message":"You have been logged off
 * because you have logged on at another location."}`).
 *
 * To avoid that collision, the dashboard exposes a toggle: when the
 * user is doing manual work, they flip auto-login OFF. While OFF,
 * {@link getSession} surfaces a clear error instead of attempting to
 * capture a new session. While ON (default), the session manager
 * re-logins automatically when the cached session is dead.
 *
 * The flag lives in `sessions/9wkts/auto-login.json` so it survives
 * restarts and can be read/written from both UI and background code.
 */
import * as fs from "fs";
import * as path from "path";

const CONFIG_PATH = path.join("sessions", "9wkts", "auto-login.json");

export interface AutoLoginConfig {
  enabled: boolean;
  /** Optional note left by whoever flipped the switch (UI attribution). */
  reason: string | null;
  /** ISO8601 timestamp of the last toggle. */
  updatedAt: string;
}

const DEFAULT_CONFIG: AutoLoginConfig = {
  enabled: true,
  reason: null,
  updatedAt: new Date(0).toISOString(),
};

/**
 * Read the current auto-login config. Returns the default (enabled)
 * when the file doesn't exist yet.
 */
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

/** Convenience — just the boolean, for hot-path callers. */
export function isAutoLoginEnabled(): boolean {
  return getAutoLoginConfig().enabled;
}

/**
 * Flip the switch. Persists immediately.
 *
 * @param enabled  True to allow auto-login (default), false to block it.
 * @param reason   Optional short note shown in the UI (e.g. "debugging in browser").
 */
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

/**
 * Error thrown by {@link getSession} when the cached session is dead
 * AND auto-login is disabled. Surfacing as a named class lets API
 * routes tell the difference between "login failed" and "login was
 * intentionally prevented".
 */
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
