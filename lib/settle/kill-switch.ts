/**
 * Persistent on/off kill-switch for the auto-settlement scheduler.
 *
 * Stored as a tiny JSON file so the operator's choice survives process
 * restarts — if an on-call engineer disables settlement at 2am, a
 * deploy two hours later must not silently re-enable it. File lives
 * beside the other session artifacts (`sessions/`) and is gitignored.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger } from "../shared/logger";

const CONFIG_PATH = resolve(
  process.cwd(),
  "sessions",
  "auto-settle-config.json",
);

export interface KillSwitchState {
  disabled: boolean;
  reason: string | null;
  updatedAt: string | null;
}

const DEFAULT_STATE: KillSwitchState = {
  disabled: false,
  reason: null,
  updatedAt: null,
};

let cached: KillSwitchState | null = null;

function read(): KillSwitchState {
  if (cached) return cached;
  try {
    if (!existsSync(CONFIG_PATH)) {
      cached = { ...DEFAULT_STATE };
      return cached;
    }
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<KillSwitchState>;
    cached = {
      disabled: Boolean(parsed.disabled),
      reason: typeof parsed.reason === "string" ? parsed.reason : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
    return cached;
  } catch (err) {
    logger.warn(
      "AutoSettle",
      `Kill-switch config unreadable — defaulting to enabled. ${(err as Error).message}`,
    );
    cached = { ...DEFAULT_STATE };
    return cached;
  }
}

function write(state: KillSwitchState): void {
  try {
    const dir = dirname(CONFIG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(state, null, 2), "utf8");
    cached = state;
  } catch (err) {
    logger.warn(
      "AutoSettle",
      `Failed to persist kill-switch: ${(err as Error).message}`,
    );
  }
}

export function isAutoSettleDisabled(): boolean {
  return read().disabled;
}

export function getKillSwitchState(): KillSwitchState {
  return { ...read() };
}

export function setAutoSettleDisabled(
  disabled: boolean,
  reason: string | null = null,
): KillSwitchState {
  const next: KillSwitchState = {
    disabled,
    reason,
    updatedAt: new Date().toISOString(),
  };
  write(next);
  return next;
}
