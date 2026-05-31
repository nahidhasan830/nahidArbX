import "dotenv/config";
import http from "node:http";
import { ensureDbReady } from "../../lib/db/client";
import {
  getEventMatcherConfig,
  readImpact,
  runEventMatcher,
} from "../../lib/event-matcher";

const port = Number(process.env.PORT || 8091);

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sendNotFound(res: http.ServerResponse): void {
  sendJson(res, 404, { error: "not_found" });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, {
        ok: true,
        service: "event-matcher",
        config: {
          deepseekEnabled: getEventMatcherConfig().deepseekEnabled,
          embeddingEnabled: getEventMatcherConfig().embeddingEnabled,
        },
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/config") {
      sendJson(res, 200, getEventMatcherConfig());
      return;
    }

    if (req.method === "GET" && url.pathname === "/impact") {
      const limit = Number(url.searchParams.get("limit") || 50);
      sendJson(res, 200, { impact: await readImpact(limit) });
      return;
    }

    if (
      req.method === "POST" &&
      ["/match/run-now", "/match/cron"].includes(url.pathname)
    ) {
      const body = asRecord(await readJson(req));
      const trigger = url.pathname === "/match/cron" ? "cron" : "manual";
      const decisionIds = Array.isArray(body.decisionIds)
        ? body.decisionIds.filter((id: unknown): id is string => {
            return typeof id === "string" && id.trim().length > 0;
          })
        : undefined;
      const summary = await runEventMatcher({
        trigger,
        mode: "apply",
        decisionIds,
        applyMerges: trigger === "cron",
        useDeepSeek:
          typeof body.useDeepSeek === "boolean" ? body.useDeepSeek : undefined,
      });
      sendJson(res, summary.status === "completed" ? 200 : 500, summary);
      return;
    }

    sendNotFound(res);
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

ensureDbReady()
  .then(() => {
    server.listen(port, () => {
      console.log(`event-matcher listening on :${port}`);
    });
  })
  .catch((err) => {
    console.error("event-matcher failed to start", err);
    process.exit(1);
  });
