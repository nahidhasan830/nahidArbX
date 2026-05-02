/**
 * Engine HTTP API Server
 *
 * Lightweight HTTP server that runs inside the engine process and
 * exposes in-memory state (events, value bets, connection health,
 * SSE stream) to the Next.js web process.
 *
 * Next.js API routes proxy to this server for any data that lives
 * only in the engine's memory (populated by the 13 background
 * subsystems).
 *
 * Default port: 3001 (configurable via ENGINE_PORT env var).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { logger } from "./logger";

export const ENGINE_PORT = parseInt(process.env.ENGINE_PORT || "3001", 10);

// ── Route handler type ────────────────────────────────────────────────

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void | Promise<void>;

const routes = new Map<string, Map<string, RouteHandler>>();

function addRoute(method: string, path: string, handler: RouteHandler) {
  if (!routes.has(method)) routes.set(method, new Map());
  routes.get(method)!.set(path, handler);
}

// ── Helper: parse URL without query ───────────────────────────────────

function pathname(req: IncomingMessage): string {
  const idx = (req.url ?? "/").indexOf("?");
  return idx === -1 ? (req.url ?? "/") : req.url!.slice(0, idx);
}

function queryParams(req: IncomingMessage): URLSearchParams {
  const idx = (req.url ?? "/").indexOf("?");
  return new URLSearchParams(idx === -1 ? "" : req.url!.slice(idx + 1));
}

function jsonResponse(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

// ── Register routes ───────────────────────────────────────────────────

export function registerEngineRoutes() {
  // These imports are lazy — they resolve to the engine's in-memory
  // singletons (already populated by the time any request arrives).

  // ── GET /engine/value-bets ──────────────────────────────────────────
  addRoute("GET", "/engine/value-bets", async (_req, res) => {
    const { getAllProviderStatus, getLastUpdate, getSyncStatus, getValueBets, getCachedStats, getMatchingStats } = await import("../store");
    const { buildConnectionHealth } = await import("./engine-health-builder");

    const params = queryParams(_req);
    const fieldsParam = params.get("fields");

    // Fast path: field-selection (e.g. ?fields=connectionHealth)
    if (fieldsParam) {
      const fields = new Set(fieldsParam.split(",").map(f => f.trim()));
      const response: Record<string, unknown> = {};
      if (fields.has("connectionHealth")) {
        response.connectionHealth = buildConnectionHealth();
      }
      if (fields.has("syncStatus")) {
        const ss = getSyncStatus();
        response.syncStatus = {
          ...ss,
          lastSyncStart: ss.lastSyncStart?.toISOString() || null,
          lastSyncEnd: ss.lastSyncEnd?.toISOString() || null,
        };
        response.lastUpdate = getLastUpdate()?.toISOString() || null;
      }
      if (fields.has("providerStatus")) {
        response.providerStatus = getAllProviderStatus();
      }
      if (fields.has("stats")) {
        response.stats = getMatchingStats();
      }
      if (fields.has("providerCounts")) {
        response.providerCounts = getCachedStats().providerCounts;
      }
      if (fields.has("summary")) {
        const cachedStats = getCachedStats();
        const allValueBets = getValueBets();
        response.summary = {
          totalEvents: cachedStats.totalEvents,
          matchedEvents: cachedStats.matchedCount,
          eventsWithValue: 0,
          eventsWithOdds: 0,
          totalValueBets: allValueBets.length,
          bestEvPct: allValueBets.length > 0 ? allValueBets[0].evPct : null,
        };
      }
      return jsonResponse(res, response);
    }

    // Full response — proxy the entire analyzed payload.
    // We re-use the same analysis logic as the Next.js route but
    // running inside the engine where the stores are populated.
    const { analyzeAndSerialize } = await import("./engine-value-bets");
    const result = await analyzeAndSerialize(params);
    return jsonResponse(res, result);
  });

  // ── GET /engine/health ──────────────────────────────────────────────
  addRoute("GET", "/engine/health", async (_req, res) => {
    const { buildConnectionHealth } = await import("./engine-health-builder");
    const { getSyncStatus, getEvents, getValueBets } = await import("../store");
    const { getStoreStats, getMatchedMarketsCount } = await import("../atoms/store");
    const { getMatchCacheStats } = await import("../matching");
    const { getSimilarityCacheStats } = await import("../matching/similarity-cache");
    const { isSchedulerRunning } = await import("../background/fetcher");
    const { getSystemHealth, getUptimeString, getMemoryStats } = await import("./health-manager");
    const { getAllCircuitBreakerStats } = await import("./circuit-breaker");

    const syncStatus = getSyncStatus();
    const systemHealth = getSystemHealth();
    const circuitBreakers = getAllCircuitBreakerStats();
    const mem = process.memoryUsage();
    const memStats = getMemoryStats();
    const atomsStoreStats = getStoreStats();
    const matchCacheStats = getMatchCacheStats();
    const similarityCacheStats = getSimilarityCacheStats();

    const response = {
      status: systemHealth.status,
      uptime: getUptimeString(),
      timestamp: new Date().toISOString(),
      connectionHealth: buildConnectionHealth(),
      components: {
        scheduler: {
          status: isSchedulerRunning() ? "healthy" : "stopped",
          running: isSchedulerRunning(),
          isSyncing: syncStatus.isSyncing,
          currentPhase: syncStatus.currentPhase,
          lastSyncEnd: syncStatus.lastSyncEnd?.toISOString() || null,
        },
      },
      circuitBreakers: Object.fromEntries(
        Object.entries(circuitBreakers).map(([id, stats]) => [
          id,
          { state: stats.state, failures: stats.failures, successes: stats.successes, timeouts: stats.timeouts },
        ]),
      ),
      memory: {
        heapUsed: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
        heapTotal: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
        rss: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
        external: Math.round((mem.external / 1024 / 1024) * 100) / 100,
        heapUsedPct: memStats.heapPct,
        stores: {
          events: getEvents().length,
          odds: atomsStoreStats.totalOddsRecords,
          families: atomsStoreStats.totalFamilies,
          matchedMarkets: getMatchedMarketsCount(),
          valueBets: getValueBets().length,
          matchCache: matchCacheStats.cachedEvents,
          similarityCache: {
            size: similarityCacheStats.size,
            maxSize: similarityCacheStats.maxSize,
            hitRate: matchCacheStats.bucketSkipRate,
          },
        },
        alert: memStats.alert,
      },
      systemHealth: {
        status: systemHealth.status,
        components: Object.fromEntries(
          Object.entries(systemHealth.components).map(([id, health]) => [
            id,
            { status: health.status, consecutiveFailures: health.consecutiveFailures },
          ]),
        ),
      },
    };

    return jsonResponse(res, response);
  });

  // ── GET /engine/stream — SSE ────────────────────────────────────────
  addRoute("GET", "/engine/stream", async (_req, res) => {
    const { syncBus } = await import("../events/event-bus");

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
    });

    const connectionId = `engine-sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    function send(event: string, data: unknown, id?: number) {
      try {
        let msg = "";
        if (id !== undefined) msg += `id: ${id}\n`;
        msg += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        res.write(msg);
      } catch { /* closed */ }
    }

    res.write("retry: 5000\n\n");
    send("connected", { connectionId, version: syncBus.version, serverTime: Date.now() }, syncBus.version);

    const unsubscribe = syncBus.subscribeWithId(connectionId, (event) => {
      if (event.type === "data:delta") {
        send("data:delta", event.delta, syncBus.version);
      } else {
        send(event.type, event, syncBus.version);
      }
    });

    const heartbeat = setInterval(() => {
      send("heartbeat", { time: Date.now(), version: syncBus.version, clients: syncBus.clientCount });
    }, 30_000);

    _req.on("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
  });

  // ── POST /engine/providers ──────────────────────────────────────────
  addRoute("POST", "/engine/providers", async (_req, res, body) => {
    const { toggleProviderAction, setDisabledProvidersAction } = await import("../providers/actions");
    const { PROVIDER_REGISTRY } = await import("../providers/registry");

    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body); } catch { return jsonResponse(res, { error: "Invalid JSON" }, 400); }

    const action = parsed.action as string;

    if (action === "setEnabled") {
      const provider = parsed.provider as string;
      const enabled = parsed.enabled as boolean;
      if (!PROVIDER_REGISTRY[provider as keyof typeof PROVIDER_REGISTRY]) {
        return jsonResponse(res, { error: `Unknown provider: ${provider}` }, 400);
      }
      const purged = toggleProviderAction(provider as keyof typeof PROVIDER_REGISTRY, enabled);
      return jsonResponse(res, { success: true, provider, enabled, purgedEvents: purged });
    }

    if (action === "setDisabled") {
      const disabled = parsed.disabled as string[];
      if (!Array.isArray(disabled)) {
        return jsonResponse(res, { error: "disabled must be an array" }, 400);
      }
      const totalPurged = setDisabledProvidersAction(disabled as (keyof typeof PROVIDER_REGISTRY)[]);
      return jsonResponse(res, { success: true, disabled, purgedEvents: totalPurged });
    }

    return jsonResponse(res, { error: `Unknown action: ${action}` }, 400);
  });

  // ── POST /engine/scheduler ──────────────────────────────────────────
  addRoute("POST", "/engine/scheduler", async (_req, res, body) => {
    const { startScheduler, stopScheduler, restartScheduler, pauseScheduler, resumeScheduler, syncAll } = await import("../background/fetcher");
    const { getSyncStatus } = await import("../store");

    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body); } catch { return jsonResponse(res, { error: "Invalid JSON" }, 400); }

    const action = parsed.action as string;
    const interval = parsed.interval as number | undefined;

    switch (action) {
      case "startScheduler": startScheduler(); break;
      case "stopScheduler": stopScheduler(); break;
      case "restartScheduler": restartScheduler(interval); break;
      case "pauseScheduler": pauseScheduler(); break;
      case "resumeScheduler": resumeScheduler(); break;
      case "syncNow": syncAll(); break;
      default: return jsonResponse(res, { ok: false, error: "Unknown action" }, 400);
    }

    const ss = getSyncStatus();
    return jsonResponse(res, {
      ok: true,
      syncStatus: {
        ...ss,
        lastSyncStart: ss.lastSyncStart?.toISOString() || null,
        lastSyncEnd: ss.lastSyncEnd?.toISOString() || null,
      },
    });
  });

  // ── POST /engine/health ─────────────────────────────────────────────
  addRoute("POST", "/engine/health", async (_req, res, body) => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body); } catch { return jsonResponse(res, { error: "Invalid JSON" }, 400); }

    const action = parsed.action as string;
    if (action === "heal") {
      const { healComponent } = await import("./health-manager");
      const success = await healComponent(parsed.component as string);
      return jsonResponse(res, { ok: success, component: parsed.component });
    }
    if (action === "healAll") {
      const { healAll } = await import("./health-manager");
      const results = await healAll();
      return jsonResponse(res, { ok: true, results });
    }
    return jsonResponse(res, { ok: false, error: "Unknown action" }, 400);
  });

  // ── GET /engine/settlement ────────────────────────────────────────────
  addRoute("GET", "/engine/settlement", async (_req, res) => {
    const { getAutoSettleStatus } = await import("../settle/scheduler");
    const { getActivityLog } = await import("../settle/activity-log");

    const params = queryParams(_req);
    const logLimit = Math.min(Math.max(Number(params.get("log") ?? 100), 0), 200);
    const activity = logLimit > 0 ? getActivityLog(logLimit) : [];

    return jsonResponse(res, {
      ...getAutoSettleStatus(),
      activity,
    });
  });

  // ── POST /engine/settlement ───────────────────────────────────────────
  addRoute("POST", "/engine/settlement", async (_req, res, body) => {
    const {
      getAutoSettleStatus,
      startAutoSettleScheduler,
      stopAutoSettleScheduler,
      restartAutoSettleScheduler,
      pauseAutoSettleScheduler,
      resumeAutoSettleScheduler,
      triggerAutoSettleNow,
    } = await import("../settle/scheduler");

    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body || "{}"); } catch { return jsonResponse(res, { error: "Invalid JSON" }, 400); }

    const action = (parsed.action as string) ?? "run";
    const intervalMs = parsed.intervalMs as number | undefined;

    try {
      switch (action) {
        case "start":
          startAutoSettleScheduler(intervalMs);
          return jsonResponse(res, getAutoSettleStatus());
        case "stop":
          stopAutoSettleScheduler();
          return jsonResponse(res, getAutoSettleStatus());
        case "restart":
          restartAutoSettleScheduler(intervalMs);
          return jsonResponse(res, getAutoSettleStatus());
        case "pause":
          pauseAutoSettleScheduler();
          return jsonResponse(res, getAutoSettleStatus());
        case "resume":
          resumeAutoSettleScheduler();
          return jsonResponse(res, getAutoSettleStatus());
        case "run":
        default: {
          const result = await triggerAutoSettleNow();
          return jsonResponse(res, { result, status: getAutoSettleStatus() });
        }
      }
    } catch (err) {
      return jsonResponse(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── GET /engine/ml/status ── live ML scorer state ──────────────────
  addRoute("GET", "/engine/ml/status", async (_req, res) => {
    try {
      const { getScorerStatus } = await import("../ml/scorer");
      return jsonResponse(res, getScorerStatus());
    } catch (err) {
      return jsonResponse(res, {
        modelLoaded: false,
        modelVersion: null,
        modelPath: null,
        featureCount: 0,
        totalScored: 0,
        avgInferenceMs: 0,
        lastInferenceMs: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── GET /engine/ml/scheduler ── retraining scheduler state ─────────
  addRoute("GET", "/engine/ml/scheduler", async (_req, res) => {
    try {
      const { getModelRetrainingSchedulerStatus } = await import(
        "../optimizer/scheduler"
      );
      return jsonResponse(res, getModelRetrainingSchedulerStatus());
    } catch (err) {
      return jsonResponse(res, {
        active: false,
        lastTickAt: null,
        totalRetrainTriggers: 0,
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

// ── Server lifecycle ──────────────────────────────────────────────────

let server: ReturnType<typeof createServer> | null = null;

export function startEngineHttp(): Promise<void> {
  return new Promise((resolve) => {
    registerEngineRoutes();

    server = createServer(async (req, res) => {
      // CORS preflight
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      const path = pathname(req);
      const method = (req.method ?? "GET").toUpperCase();
      const methodRoutes = routes.get(method);
      const handler = methodRoutes?.get(path);

      if (!handler) {
        jsonResponse(res, { error: "Not found" }, 404);
        return;
      }

      // Read body for POST
      let body = "";
      if (method === "POST") {
        body = await new Promise<string>((resolveBody) => {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => resolveBody(Buffer.concat(chunks).toString()));
        });
      }

      try {
        await handler(req, res, body);
      } catch (err) {
        logger.error("EngineHTTP", `Handler error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          jsonResponse(res, { error: "Internal server error" }, 500);
        }
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        logger.warn("EngineHTTP", `Port ${ENGINE_PORT} in use — killing stale process and retrying...`);
        import("child_process").then(({ execSync }) => {
          try {
            execSync(`lsof -ti:${ENGINE_PORT} | xargs kill -9 2>/dev/null`, { stdio: "ignore" });
          } catch { /* nothing to kill */ }
          setTimeout(() => {
            server!.listen(ENGINE_PORT, () => {
              logger.info("EngineHTTP", `Engine HTTP API listening on port ${ENGINE_PORT} (retry)`);
              resolve();
            });
          }, 500);
        });
      } else {
        logger.error("EngineHTTP", `Server error: ${err.message}`);
      }
    });

    server.listen(ENGINE_PORT, () => {
      logger.info("EngineHTTP", `Engine HTTP API listening on port ${ENGINE_PORT}`);
      resolve();
    });
  });
}

export function stopEngineHttp(): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
}
