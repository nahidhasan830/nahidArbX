/**
 * AI Search API — powered by Node.js grounding engine (DeepSeek + Vertex/Brave).
 *
 * GET  /api/ai-search/stats          -> provider stats
 * GET  /api/ai-search/healthz        -> engine health
 * GET  /api/ai-search/models         -> available models
 * GET  /api/ai-search/llm-stats      -> LLM usage stats
 * GET  /api/ai-search/logs           -> Read from DB (ai_search_logs)
 * POST /api/ai-search/search         -> raw web search
 * POST /api/ai-search/entity-match   -> single-pair entity matching
 * POST /api/ai-search/grounded-query -> search-grounded Q&A
 * POST /api/ai-search/verify-settlement -> match result verification
 * POST /api/ai-search/providers/{name}/toggle -> enable/disable provider
 */

import { NextRequest, NextResponse } from "next/server";
import { insertAiSearchLog } from "@/lib/db/repositories/ai-search-logs";
import { listAiSearchLogs } from "@/lib/db/repositories/ai-search-logs";
import { recordAiActivity } from "@/lib/db/repositories/ai-activity-log";
import { getGroundingEngine } from "@/lib/ai/grounding";
import { getSearchRouter } from "@/lib/ai/search/router";
import type { EventInfo } from "@/lib/ai/search/types";

const ENDPOINT_SYSTEM: Record<string, string> = {
  search: "grounding",
  "grounded-query": "grounding",
  "entity-match": "entity-match",
  "verify-settlement": "settlement",
};

const LOGGED_ENDPOINTS = new Set([
  "search",
  "entity-match",
  "grounded-query",
  "verify-settlement",
]);

const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const subPath = path.join("/");

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

  const allowed = ["stats", "healthz", "models", "llm-stats"];
  if (!allowed.includes(subPath)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    if (subPath === "healthz") {
      const apiKey = process.env.DEEPSEEK_API_KEY;
      const llmHealthy = Boolean(apiKey);
      const stats = getSearchRouter().getStats();
      const providersHealthy = stats.providers.filter((p) => p.healthy).length;

      return NextResponse.json({
        status: llmHealthy && providersHealthy > 0 ? "ok" : "degraded",
        llmEngine: {
          active: "deepseek",
          model: DEEPSEEK_MODEL,
          healthy: llmHealthy,
        },
        searchProviders: {
          total: stats.providers.length,
          healthy: providersHealthy,
        },
      });
    }

    if (subPath === "stats") {
      const stats = getSearchRouter().getStats();
      return NextResponse.json({
        providers: stats.providers,
        totalSearches: stats.totalSearches,
        llmEngine: DEEPSEEK_MODEL,
        llmHealthy: Boolean(process.env.DEEPSEEK_API_KEY),
        serviceOffline: false,
      });
    }

    if (subPath === "models") {
      return NextResponse.json({
        engine: "deepseek",
        model: DEEPSEEK_MODEL,
        healthy: Boolean(process.env.DEEPSEEK_API_KEY),
      });
    }

    if (subPath === "llm-stats") {
      const { getProviderConfigs } = await import("@/lib/db/repositories/ai-provider-config");
      const geminiHealthy = Boolean(process.env.GEMINI_API_KEY);

      const configs = await getProviderConfigs().catch(() => {
        return {} as Record<string, { enabled: boolean; disabledReason: string | null }>;
      });

      const deepseekCfg = configs["deepseek-lite"] ?? configs["deepseek-pro"] ?? { enabled: true, disabledReason: null };
      const geminiCfg = configs["gemini-lite"] ?? configs["gemini-flash"] ?? configs["gemini-pro"] ?? { enabled: true, disabledReason: null };

      const providers: Record<string, Record<string, unknown>> = {};

      providers["deepseek"] = {
        model: DEEPSEEK_MODEL,
        healthy: Boolean(process.env.DEEPSEEK_API_KEY),
        disabled: !deepseekCfg.enabled,
        manual_disabled: !deepseekCfg.enabled,
        disabled_reason: deepseekCfg.disabledReason ?? null,
        is_exhausted: !Boolean(process.env.DEEPSEEK_API_KEY),
      };

      if (geminiHealthy) {
        providers["gemini"] = {
          model: process.env.GEMINI_FLASH_MODEL || "gemini-3-flash",
          healthy: true,
          disabled: !geminiCfg.enabled,
          manual_disabled: !geminiCfg.enabled,
          disabled_reason: geminiCfg.disabledReason ?? null,
          is_exhausted: false,
        };
      }

      const activeEngine = deepseekCfg.enabled && Boolean(process.env.DEEPSEEK_API_KEY)
        ? "deepseek"
        : geminiCfg.enabled && geminiHealthy
          ? "gemini"
          : "none";

      return NextResponse.json({
        model: DEEPSEEK_MODEL,
        usage: {
          active_engine: activeEngine,
          providers,
        },
      });
    }

    return NextResponse.json({ error: "Unknown endpoint" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: "AI engine error", detail: String(err) },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const subPath = path.join("/");

  const directAllowed = ["search", "entity-match", "grounded-query", "verify-settlement"];
  const isProviderToggle = /^providers\/[^/]+\/toggle$/.test(subPath);
  if (!directAllowed.includes(subPath) && !isProviderToggle) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const startMs = Date.now();

  try {
    const body = await req.json();

    // Provider toggle
    if (isProviderToggle) {
      const name = subPath.split("/")[1];
      const ok = getGroundingEngine().toggleProvider(name, body.enabled);
      if (!ok) {
        return NextResponse.json({ error: `Provider '${name}' not found` }, { status: 404 });
      }
      return NextResponse.json({ name, enabled: body.enabled });
    }

    // Raw search
    if (subPath === "search") {
      const { results, provider } = await getSearchRouter().search(
        body.query || "",
        body.max_results || 5,
        body.providers,
      );
      return logAndRespond(subPath, body, startMs, {
        query: body.query,
        results,
        providerUsed: provider,
      });
    }

    // Entity match
    if (subPath === "entity-match") {
      const eventA: EventInfo = {
        homeTeam: body.event_a?.home_team || "",
        awayTeam: body.event_a?.away_team || "",
        competition: body.event_a?.competition || "",
        startTime: body.event_a?.start_time || "",
        provider: body.event_a?.provider,
      };
      const eventB: EventInfo = {
        homeTeam: body.event_b?.home_team || "",
        awayTeam: body.event_b?.away_team || "",
        competition: body.event_b?.competition || "",
        startTime: body.event_b?.start_time || "",
        provider: body.event_b?.provider,
      };
      const result = await getGroundingEngine().matchSingle(eventA, eventB);
      return logAndRespond(subPath, body, startMs, {
        decision: result.decision,
        confidence: result.confidence,
        reasoning: result.reasoning,
        sources: result.sources,
        searchQueriesUsed: result.searchQueriesUsed,
        model: result.model,
      });
    }

    // Grounded query
    if (subPath === "grounded-query") {
      const question = body.question || body.query || "";
      const llmProvider = (body.provider as "deepseek" | "gemini") || "deepseek";
      const result = await getGroundingEngine().query(question, body.context, {
        provider: llmProvider,
        model: body.model,
      });
      return logAndRespond(subPath, body, startMs, {
        answer: result.answer,
        reasoning: result.reasoning,
        sources: result.sources,
        model: result.model,
        providerUsed: llmProvider,
      });
    }

    // Settlement verification
    if (subPath === "verify-settlement") {
      const event: EventInfo = {
        homeTeam: body.event?.home_team || "",
        awayTeam: body.event?.away_team || "",
        competition: body.event?.competition || "",
        startTime: body.event?.start_time || "",
        provider: body.event?.provider,
      };
      const result = await getGroundingEngine().verifySettlement(event, body.question || "");
      return logAndRespond(subPath, body, startMs, {
        answer: result.answer,
        confidence: result.confidence,
        reasoning: result.reasoning,
        sources: result.sources,
        model: result.model,
      });
    }

    return NextResponse.json({ error: "Unknown endpoint" }, { status: 400 });
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errMsg = err instanceof Error ? err.message : String(err);

    if (LOGGED_ENDPOINTS.has(subPath)) {
      insertAiSearchLog({
        endpoint: subPath,
        service: "Manual",
        status: "error",
        providerUsed: null,
        modelUsed: null,
        query: null,
        durationMs,
        resultCount: null,
        error: errMsg.slice(0, 2000),
        requestBody: null,
        responseSummary: null,
      }).catch(() => {});

      recordAiActivity({
        system: ENDPOINT_SYSTEM[subPath] ?? "grounding",
        trigger: "manual",
        status: "error",
        model: null,
        itemCount: null,
        durationMs,
        costUsd: null,
        summary: `${subPath} failed`,
        error: errMsg.slice(0, 2000),
        metadata: null,
      }).catch(() => {});
    }

    return NextResponse.json(
      { error: "AI engine error", detail: errMsg },
      { status: 500 },
    );
  }
}

async function logAndRespond(
  subPath: string,
  body: Record<string, unknown>,
  startMs: number,
  data: Record<string, unknown>,
) {
  const durationMs = Date.now() - startMs;

  if (LOGGED_ENDPOINTS.has(subPath)) {
    const bodyService = (body.service as string) || "Manual";
    const bodyQuery = ((body.query ?? body.question) as string) || null;
    insertAiSearchLog({
      endpoint: subPath,
      service: bodyService,
      status: "success",
      providerUsed: (data.providerUsed as string) ?? null,
      modelUsed: (data.model as string) ?? DEEPSEEK_MODEL,
      query: bodyQuery,
      durationMs,
      resultCount: Array.isArray(data.results) ? data.results.length : null,
      error: null,
      requestBody: truncateJson(body),
      responseSummary: truncateJson(data, 4000),
    }).catch(() => {});

    recordAiActivity({
      system: ENDPOINT_SYSTEM[subPath] ?? "grounding",
      trigger: bodyService === "Playground" ? "playground" : bodyService === "Auto Matcher" ? "batch" : "manual",
      status: "success",
      model: (data.model as string) ?? DEEPSEEK_MODEL,
      itemCount: Array.isArray(data.results) ? data.results.length : 1,
      durationMs,
      costUsd: null,
      summary: `${subPath}: ${(bodyQuery || "(no query)").slice(0, 500)}`,
      error: null,
      metadata: { provider: data.providerUsed ?? null },
    }).catch(() => {});
  }

  return NextResponse.json(data);
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
