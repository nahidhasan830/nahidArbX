/**
 * Proxy route for the ai-search Python service.
 *
 * GET  /api/ai-search/stats          -> GET  AI_SEARCH_URL/stats
 * GET  /api/ai-search/healthz        -> GET  AI_SEARCH_URL/healthz
 * GET  /api/ai-search/models         -> GET  AI_SEARCH_URL/models
 * GET  /api/ai-search/logs           -> Read from DB (ai_search_logs)
 * POST /api/ai-search/search         -> POST AI_SEARCH_URL/search  (+ log)
 * POST /api/ai-search/entity-match   -> POST AI_SEARCH_URL/entity-match (+ log)
 * POST /api/ai-search/grounded-query -> POST AI_SEARCH_URL/grounded-query (+ log)
 * POST /api/ai-search/verify-settlement -> POST AI_SEARCH_URL/verify-settlement (+ log)
 * POST /api/ai-search/providers/x/toggle -> POST AI_SEARCH_URL/providers/x/toggle
 *
 * Keeps the Python service internal (no CORS, no auth bypass).
 * POST endpoints that hit an AI/search function are logged to the
 * ai_search_logs Postgres table via Drizzle.
 */

import { NextRequest, NextResponse } from "next/server";
import { insertAiSearchLog } from "@/lib/db/repositories/ai-search-logs";
import { listAiSearchLogs } from "@/lib/db/repositories/ai-search-logs";
import { recordAiActivity } from "@/lib/db/repositories/ai-activity-log";
import { isHFAvailable, chatWithHF } from "@/lib/ai/hf-client";

/** Map endpoint path to AI activity system tag. */
const ENDPOINT_SYSTEM: Record<string, string> = {
  search: "grounding",
  "grounded-query": "grounding",
  "entity-match": "entity-match",
  "verify-settlement": "settlement",
};

const AI_SEARCH_URL = process.env.AI_SEARCH_URL || "http://localhost:8090";

/** Endpoints whose calls are logged to the database. */
const LOGGED_ENDPOINTS = new Set([
  "search",
  "entity-match",
  "grounded-query",
  "verify-settlement",
]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const subPath = path.join("/");

  // ── DB-backed logs endpoint ──
  if (subPath === "logs") {
    const sp = req.nextUrl.searchParams;
    const filters = {
      status: (sp.get("status") as "success" | "error") || undefined,
      service: sp.get("service") || undefined,
      limit: sp.has("limit") ? Number(sp.get("limit")) : 100,
      offset: sp.has("offset") ? Number(sp.get("offset")) : 0,
    };
    try {
      const result = await listAiSearchLogs(filters);
      return NextResponse.json(result);
    } catch (err) {
      return NextResponse.json(
        { error: "Failed to read logs", detail: String(err) },
        { status: 500 },
      );
    }
  }

  // ── Proxy pass-through GETs ──
  const allowed = ["stats", "healthz", "models", "llm-stats"];
  if (!allowed.includes(subPath)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const resp = await fetch(`${AI_SEARCH_URL}/${subPath}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });

    if (!resp.ok) {
      const detail = await readUpstreamBody(resp);
      return NextResponse.json(
        { error: `Upstream returned ${resp.status}`, detail },
        { status: resp.status },
      );
    }

    const data = await resp.json();

    // Inject hf_available into stats response
    if (subPath === "stats") {
      (data as Record<string, unknown>).hf_available = isHFAvailable();
    }

    return NextResponse.json(data);
  } catch (err) {
    if (subPath === "healthz") {
      return NextResponse.json(buildFallbackHealth(err));
    }
    if (subPath === "stats") {
      return NextResponse.json(buildFallbackStats(err));
    }
    if (subPath === "models") {
      return NextResponse.json(buildFallbackModels(err));
    }

    return NextResponse.json(
      {
        error: "AI search service unreachable",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const subPath = path.join("/");

  // Whitelist: direct endpoints + providers/*/toggle
  const directAllowed = [
    "search",
    "entity-match",
    "grounded-query",
    "verify-settlement",
  ];
  const isProviderToggle = /^providers\/[^/]+\/toggle$/.test(subPath);
  if (!directAllowed.includes(subPath) && !isProviderToggle) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const startMs = Date.now();

  try {
    const body = await req.json();

    // ── HuggingFace direct path (Playground only) ──
    if (
      subPath === "grounded-query" &&
      body.provider === "huggingface" &&
      isHFAvailable()
    ) {
      try {
        const result = await chatWithHF({
          system:
            "You are a helpful AI assistant. Answer the user's question clearly and concisely.",
          prompt: body.question ?? body.query ?? "",
          model: body.hf_model || undefined,
          jsonMode: false,
          temperature: body.temperature ?? 0.1,
        });
        const durationMs = Date.now() - startMs;

        insertAiSearchLog({
          endpoint: subPath,
          service: body.service ?? "Playground",
          status: "success",
          providerUsed: "huggingface",
          modelUsed: result.model,
          query: body.question ?? body.query ?? null,
          durationMs,
          resultCount: null,
          error: null,
          requestBody: truncateJson(body),
          responseSummary: truncateJson({ answer: result.text, model: result.model }, 4000),
        }).catch(() => {});

        recordAiActivity({
          system: "grounding",
          trigger: "playground",
          status: "success",
          model: result.model,
          itemCount: 1,
          durationMs,
          costUsd: null,
          summary: `HF grounded-query: ${(body.question ?? body.query ?? "(no query)").slice(0, 500)}`,
          error: null,
          metadata: { provider: "huggingface", finishReason: result.finishReason },
        }).catch(() => {});

        return NextResponse.json({
          answer: result.text,
          reasoning: "",
          sources: [],
          model: result.model,
          provider_used: "huggingface",
        });
      } catch (err) {
        const durationMs = Date.now() - startMs;
        const errMsg = err instanceof Error ? err.message : String(err);

        insertAiSearchLog({
          endpoint: subPath,
          service: body.service ?? "Playground",
          status: "error",
          providerUsed: "huggingface",
          modelUsed: body.hf_model ?? null,
          query: body.question ?? body.query ?? null,
          durationMs,
          resultCount: null,
          error: errMsg.slice(0, 2000),
          requestBody: truncateJson(body),
          responseSummary: null,
        }).catch(() => {});

        recordAiActivity({
          system: "grounding",
          trigger: "playground",
          status: "error",
          model: body.hf_model ?? null,
          itemCount: 1,
          durationMs,
          costUsd: null,
          summary: `HF grounded-query failed`,
          error: errMsg.slice(0, 2000),
          metadata: null,
        }).catch(() => {});

        return NextResponse.json(
          { error: "HuggingFace request failed", detail: errMsg },
          { status: 502 },
        );
      }
    }

    const upstreamBody =
      subPath === "grounded-query"
        ? {
            ...body,
            question: body.question ?? body.query ?? "",
            query: undefined,
          }
        : body;

    const resp = await fetch(`${AI_SEARCH_URL}/${subPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(60_000), // LLM calls can be slow
    });

    if (!resp.ok) {
      const errBody = await readUpstreamBody(resp);
      const errText = stringifyForLog(errBody);
      const durationMs = Date.now() - startMs;

      // Log errors for tracked endpoints
      if (LOGGED_ENDPOINTS.has(subPath)) {
        insertAiSearchLog({
          endpoint: subPath,
          service: body.service ?? "Manual",
          status: "error",
          providerUsed: null,
          modelUsed: body.model ?? null,
          query: body.query ?? body.question ?? null,
          durationMs,
          resultCount: null,
          error: errText.slice(0, 2000),
          requestBody: truncateJson(body),
          responseSummary: null,
        }).catch(() => {}); // fire-and-forget

        recordAiActivity({
          system: ENDPOINT_SYSTEM[subPath] ?? "grounding",
          trigger: body.service === "Playground" ? "playground" : body.service === "Auto Matcher" ? "batch" : "manual",
          status: "error",
          model: body.model ?? null,
          itemCount: 1,
          durationMs,
          costUsd: null,
          summary: `${subPath} failed: ${errText.slice(0, 200)}`,
          error: errText.slice(0, 2000),
          metadata: null,
        }).catch(() => {});
      }

      return NextResponse.json(
        { error: `Upstream returned ${resp.status}`, detail: errBody },
        { status: resp.status },
      );
    }

    const data = await resp.json();
    const durationMs = Date.now() - startMs;

    // Log successful calls for tracked endpoints
    if (LOGGED_ENDPOINTS.has(subPath)) {
      insertAiSearchLog({
        endpoint: subPath,
        service: body.service ?? "Manual",
        status: "success",
        providerUsed: data.provider_used ?? null,
        modelUsed: data.model ?? body.model ?? null,
        query: body.query ?? body.question ?? null,
        durationMs,
        resultCount: data.results?.length ?? null,
        error: null,
        requestBody: truncateJson(body),
        responseSummary: truncateJson(data, 4000),
      }).catch(() => {}); // fire-and-forget

      recordAiActivity({
        system: ENDPOINT_SYSTEM[subPath] ?? "grounding",
        trigger: body.service === "Playground" ? "playground" : body.service === "Auto Matcher" ? "batch" : "manual",
        status: "success",
        model: data.model ?? body.model ?? null,
        itemCount: data.results?.length ?? 1,
        durationMs,
        costUsd: null, // local models are free
        summary: `${subPath}: ${body.query ?? body.question ?? "(no query)"}`.slice(0, 500),
        error: null,
        metadata: { provider: data.provider_used ?? null },
      }).catch(() => {});
    }

    return NextResponse.json(data);
  } catch (err) {
    const durationMs = Date.now() - startMs;

    if (LOGGED_ENDPOINTS.has(subPath)) {
      // Attempt to parse body for logging — may fail if body was already consumed
      insertAiSearchLog({
        endpoint: subPath,
        service: "Manual",
        status: "error",
        providerUsed: null,
        modelUsed: null,
        query: null,
        durationMs,
        resultCount: null,
        error: err instanceof Error ? err.message : String(err),
        requestBody: null,
        responseSummary: null,
      }).catch(() => {}); // fire-and-forget

      recordAiActivity({
        system: ENDPOINT_SYSTEM[subPath] ?? "grounding",
        trigger: "manual",
        status: "error",
        model: null,
        itemCount: null,
        durationMs,
        costUsd: null,
        summary: `${subPath} unreachable`,
        error: err instanceof Error ? err.message : String(err),
        metadata: null,
      }).catch(() => {});
    }

    return NextResponse.json(
      {
        error: "AI search service unreachable",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function buildFallbackHealth(err: unknown) {
  return {
    status: "offline",
    service: {
      healthy: false,
      url: AI_SEARCH_URL,
      error: err instanceof Error ? err.message : String(err),
    },
    llm_engine: {
      active: "unknown",
      providers: {},
    },
    search_providers: { total: 0, healthy: 0 },
  };
}

function buildFallbackStats(err: unknown) {
  return {
    providers: [],
    total_searches: 0,
    llm_engine: "llama-3.3-70b-versatile",
    llm_healthy: false,
    service_offline: true,
    service_error: err instanceof Error ? err.message : String(err),
    hf_available: isHFAvailable(),
  };
}

function buildFallbackModels(err: unknown) {
  return {
    engine: "unknown",
    model: "unknown",
    healthy: false,
    service_offline: true,
    service_error: err instanceof Error ? err.message : String(err),
  };
}

async function readUpstreamBody(resp: Response): Promise<unknown> {
  const text = await resp.text().catch(() => "");
  if (!text) return "";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function stringifyForLog(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateJson(obj: unknown, maxLen = 2000): object | null {
  try {
    const str = JSON.stringify(obj);
    if (str.length <= maxLen) return obj as object;
    return JSON.parse(str.slice(0, maxLen - 1) + "}");
  } catch {
    return null;
  }
}
