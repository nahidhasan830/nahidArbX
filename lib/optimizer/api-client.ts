/**
 * Typed wrapper around the Python sidecar's HTTP API.
 *
 * Auth: shared HMAC token via `X-Optimizer-Token`. Empty secret = dev-mode
 * unauthenticated (localhost only).
 */

import { logger } from "../shared/logger";

const tag = "OptimizerClient";

export interface SidecarHealth {
  status: "ok" | "degraded";
  db: string;
  active_runs: string[];
}

const baseUrl = (): string =>
  process.env.OPTIMIZER_URL ?? "http://localhost:8001";

const headers = (): Record<string, string> => {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env.OPTIMIZER_SHARED_SECRET;
  if (token) h["X-Optimizer-Token"] = token;
  return h;
};

async function post<T>(
  path: string,
  body: unknown,
  timeoutMs = 5000,
): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`sidecar ${res.status}: ${text || res.statusText}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

async function get<T>(path: string, timeoutMs = 5000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method: "GET",
      headers: headers(),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`sidecar ${res.status}: ${res.statusText}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export async function startRun(
  runId: string,
): Promise<{ status: string; run_id: string }> {
  return post("/run/start", { run_id: runId });
}

export async function cancelSidecarRun(
  runId: string,
): Promise<{ status: string; run_id: string }> {
  return post("/run/cancel", { run_id: runId });
}

export async function pingSidecar(): Promise<SidecarHealth | null> {
  try {
    return await get<SidecarHealth>("/health", 2000);
  } catch (err) {
    logger.warn(
      tag,
      `Sidecar unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
