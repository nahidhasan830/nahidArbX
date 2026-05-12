/**
 * Unified boot coordination.
 *
 * When `NAHIDARBX_UNIFIED_BOOT=1` (set by `npm run dev:all`), each
 * process writes its boot payload to a shared temp directory instead
 * of sending a Telegram notification immediately. The frontend (last
 * to start) collects all payloads and sends a single combined message.
 *
 * Individual starts (no env var) bypass this entirely — each process
 * sends its own notification as before.
 */

import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BOOT_DIR = join(tmpdir(), "nahidarbx-boot");

export type BootRole = "engine" | "ai-search" | "frontend";

export interface BootPayload {
  role: BootRole;
  at: string;
  data: Record<string, unknown>;
}

/** Returns true when `dev:all` set the unified-boot env var. */
export function isUnifiedBoot(): boolean {
  return process.env.NAHIDARBX_UNIFIED_BOOT === "1";
}

/**
 * Persist a boot payload so the collector (frontend) can pick it up.
 * Creates the directory if it doesn't exist yet.
 */
export function writeBootPayload(
  role: BootRole,
  data: Record<string, unknown>,
): void {
  mkdirSync(BOOT_DIR, { recursive: true });
  const payload: BootPayload = {
    role,
    at: new Date().toISOString(),
    data,
  };
  writeFileSync(
    join(BOOT_DIR, `${role}.json`),
    JSON.stringify(payload, null, 2),
    "utf-8",
  );
}

/**
 * Read all boot payloads from the shared directory. Returns an array
 * of parsed payloads (may be empty if nothing was written yet).
 */
export function collectBootPayloads(): BootPayload[] {
  try {
    const files = readdirSync(BOOT_DIR).filter((f) => f.endsWith(".json"));
    return files.map((f) => {
      const raw = readFileSync(join(BOOT_DIR, f), "utf-8");
      return JSON.parse(raw) as BootPayload;
    });
  } catch {
    return [];
  }
}
