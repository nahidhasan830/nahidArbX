
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BOOT_DIR = join(tmpdir(), "nahidarbx-boot");

export type BootRole = "engine" | "frontend";

export interface BootPayload {
  role: BootRole;
  at: string;
  data: Record<string, unknown>;
}

export function isUnifiedBoot(): boolean {
  return process.env.NAHIDARBX_UNIFIED_BOOT === "1";
}

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

export async function waitForBootPayloads(
  roles: BootRole[],
  {
    timeoutMs = 10_000,
    intervalMs = 250,
  }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<BootPayload[]> {
  const deadline = Date.now() + timeoutMs;
  let payloads = collectBootPayloads();

  while (
    Date.now() < deadline &&
    !roles.every((role) => payloads.some((payload) => payload.role === role))
  ) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    payloads = collectBootPayloads();
  }

  return payloads;
}
