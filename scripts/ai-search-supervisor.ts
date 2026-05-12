import "dotenv/config";

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { notify } from "../lib/notifier";

const SERVICE_DIR = resolve(process.cwd(), "services/ai-search");
const VENV_PYTHON = resolve(SERVICE_DIR, ".venv/bin/python");
const PYTHON = existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";
const PORT = process.env.AI_SEARCH_PORT || "8090";
const HOST = process.env.AI_SEARCH_HOST || "0.0.0.0";
const SERVICE_URL = process.env.AI_SEARCH_URL || `http://localhost:${PORT}`;
const CONFIGURED_MODEL =
  process.env.HF_MODEL ||
  process.env.GROQ_MODEL ||
  "meta-llama/Llama-3.3-70B-Instruct";  // HF format (primary)
const STARTUP_TIMEOUT_MS = Number(
  process.env.AI_SEARCH_STARTUP_TIMEOUT_MS || "60000",
);

let child: ChildProcess | null = null;
let startedNotified = false;
let stopNotified = false;
let stoppingReason: string | null = null;
let forceKillTimer: NodeJS.Timeout | null = null;
const startedAt = Date.now();

main().catch(async (err) => {
  const reason = err instanceof Error ? err.message : String(err);
  if (child && child.exitCode === null) {
    stoppingReason = reason;
    child.kill("SIGTERM");
  }
  await notifyEngineState("failed", { reason });
  console.error(`[ai-search] ${reason}`);
  process.exit(1);
});

async function main() {
  console.log(`[ai-search] starting Python service from ${SERVICE_DIR}`);
  console.log(
    `[ai-search] ${PYTHON} -m uvicorn app.main:app --host ${HOST} --port ${PORT} --reload`,
  );

  child = spawn(
    PYTHON,
    [
      "-m",
      "uvicorn",
      "app.main:app",
      "--host",
      HOST,
      "--port",
      PORT,
      "--reload",
    ],
    {
      cwd: SERVICE_DIR,
      env: {
        ...process.env,
        AI_SEARCH_PORT: PORT,
      },
      stdio: "inherit",
    },
  );

  child.on("error", async (err) => {
    await notifyEngineState("failed", { reason: err.message });
  });

  child.on("exit", async (code, signal) => {
    if (forceKillTimer) clearTimeout(forceKillTimer);

    const state = startedNotified ? "stopped" : "failed";
    await notifyEngineState(state, {
      exitCode: code,
      signal,
      reason: stoppingReason,
    });

    process.exit(code ?? (signal ? 0 : 1));
  });

  bindShutdown("SIGINT");
  bindShutdown("SIGTERM");

  const health = await waitForHealth();
  startedNotified = true;
  await notifyEngineState("started", { health });
}

function bindShutdown(signal: NodeJS.Signals) {
  process.once(signal, () => {
    stoppingReason = `received ${signal}`;
    console.log(`[ai-search] ${stoppingReason}; stopping Python service...`);

    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");

    forceKillTimer = setTimeout(() => {
      if (child && child.exitCode === null) {
        stoppingReason = `${stoppingReason}; forced SIGKILL after timeout`;
        child.kill("SIGKILL");
      }
    }, 5000);
  });
}

async function waitForHealth(): Promise<AiSearchHealth | null> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    if (child?.exitCode !== null) {
      throw new Error(
        `AI search exited before health check passed (${child?.exitCode})`,
      );
    }

    try {
      const health = await fetchJson<AiSearchHealth>(
        `${SERVICE_URL}/healthz`,
        3000,
      );
      console.log(`[ai-search] healthy: ${health.status}`);
      return health;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(1000);
    }
  }

  throw new Error(
    `AI search did not become healthy within ${STARTUP_TIMEOUT_MS}ms: ${lastError ?? "unknown error"}`,
  );
}

async function notifyEngineState(
  state: "started" | "stopped" | "failed",
  opts: {
    health?: AiSearchHealth | null;
    exitCode?: number | null;
    signal?: NodeJS.Signals | string | null;
    reason?: string | null;
  } = {},
) {
  if (stopNotified && state !== "started") return;
  if (state !== "started") stopNotified = true;

  const health = opts.health;
  const llmHealthy =
    typeof health?.llm_engine?.healthy === "boolean"
      ? health.llm_engine.healthy
      : health?.status === "ok" || health?.status === "degraded";
  const llmEngine =
    health?.llm_engine?.active ??
    (process.env.HF_API_KEY ? "huggingface" : "groq");

  const payload = {
    type: "ai:engine_state" as const,
    at: new Date().toISOString(),
    state,
    serviceUrl: SERVICE_URL,
    pid: child?.pid,
    exitCode: opts.exitCode,
    signal: opts.signal,
    uptimeMs: Date.now() - startedAt,
    configuredModel: health?.llm_engine?.model ?? CONFIGURED_MODEL,
    llmEngine,
    llmHealthy,
    providersHealthy: health?.search_providers?.healthy,
    providersTotal: health?.search_providers?.total,
    reason: opts.reason,
  };

  // For "started" events during unified boot, write payload to disk
  // so the frontend collector can merge it into a single notification.
  // Stop/fail events always notify immediately (runtime events, not boot).
  if (state === "started") {
    const { isUnifiedBoot, writeBootPayload } =
      await import("../lib/notifier/unified-boot");
    if (isUnifiedBoot()) {
      writeBootPayload("ai-search", payload);
      console.log("[ai-search] Wrote boot payload for unified notification");
      return;
    }
  }

  await notify(payload);
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return (await res.json()) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

interface AiSearchHealth {
  status: string;
  llm_engine?: {
    active?: string;
    model: string;
    healthy: boolean;
  };
  search_providers?: {
    total: number;
    healthy: number;
  };
}
