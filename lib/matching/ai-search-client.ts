/**
 * AI Search client — uses the local Node.js grounding engine (DeepSeek + Vertex/Brave).
 *
 * Previously called the Python FastAPI gateway at `AI_SEARCH_URL`. Now calls
 * the in-process grounding engine directly for entity match, batch match,
 * and grounded entity matching.
 *
 * Failure mode: every call returns `null` on error. Callers treat `null` as
 * "service unavailable → fall through to human_review".
 */

import { logger } from "../shared/logger";
import { recordAiActivity } from "../db/repositories/ai-activity-log";
import { getGroundingEngine } from "../ai/grounding";
import type { EventInfo, SourceCitation } from "../ai/search/types";

const tag = "AiSearchClient";

/** Batch endpoint accepts at most 20 pairs per call. */
const MAX_BATCH_SIZE = 20;

// ─── Types (re-exported from lib/ai/search/types with camelCase aliases) ────

export interface AiSearchEventInfo {
  home_team: string;
  away_team: string;
  competition: string;
  start_time: string; // ISO 8601
  provider?: string;
}

export interface AiSearchSourceCitation {
  url: string;
  title: string;
  snippet: string;
}

export interface AiSearchMatchVerdict {
  decision: "SAME" | "DIFFERENT" | "UNCERTAIN";
  confidence: number; // 0-100
  reasoning: string;
  sources: AiSearchSourceCitation[];
  searchQueriesUsed: string[];
  model: string;
  diagnostics?: {
    parseStatus: "valid" | "recovered" | "invalid";
    finishReason?: string;
    warning?: string;
  };
}

export interface AiSearchPairVerdict {
  pair_index: number;
  decision: "SAME" | "DIFFERENT" | "UNCERTAIN";
  confidence: number; // 0-100
  reasoning: string;
  diagnostics?: {
    parseStatus: "valid" | "recovered" | "invalid";
    finishReason?: string;
    warning?: string;
  };
}

export interface AiSearchBatchResult {
  verdicts: AiSearchPairVerdict[];
  sources: AiSearchSourceCitation[];
  searchQueriesUsed: string[];
  model: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function toEventInfo(e: AiSearchEventInfo): EventInfo {
  return {
    homeTeam: e.home_team,
    awayTeam: e.away_team,
    competition: e.competition,
    startTime: e.start_time,
    provider: e.provider,
  };
}

function toSnakeCitations(src: SourceCitation[]): AiSearchSourceCitation[] {
  return src.map((s) => ({ url: s.url, title: s.title, snippet: s.snippet }));
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Match a single event pair using search-grounded AI (DeepSeek + Vertex/Brave).
 */
export async function matchSingle(
  eventA: AiSearchEventInfo,
  eventB: AiSearchEventInfo,
  _opts?: { llmProvider?: string },
): Promise<AiSearchMatchVerdict | null> {
  const t0 = Date.now();
  const pairLabel = `${eventA.home_team} v ${eventA.away_team} vs ${eventB.home_team} v ${eventB.away_team}`;

  try {
    const engine = getGroundingEngine();
    const result = await engine.matchSingle(
      toEventInfo(eventA),
      toEventInfo(eventB),
    );

    const durationMs = Date.now() - t0;
    recordAiActivity({
      system: "entity-match",
      trigger: "manual",
      status: "success",
      model: result.model,
      itemCount: 1,
      durationMs,
      costUsd: null,
      summary: `AI Search single: ${result.decision} ${result.confidence}% — ${pairLabel}`,
      error: null,
      metadata: {
        decision: result.decision,
        confidence: result.confidence,
        sourcesCount: result.sources?.length ?? 0,
        diagnostics: result.diagnostics ?? null,
      },
    }).catch(() => {});

    return {
      decision: result.decision,
      confidence: result.confidence,
      reasoning: result.reasoning,
      sources: toSnakeCitations(result.sources),
      searchQueriesUsed: result.searchQueriesUsed,
      model: result.model,
      diagnostics: result.diagnostics,
    };
  } catch (err) {
    const durationMs = Date.now() - t0;
    logger.warn(tag, `matchSingle failed: ${(err as Error).message}`);
    recordAiActivity({
      system: "entity-match",
      trigger: "manual",
      status: "error",
      model: "deepseek-v4-flash",
      itemCount: 1,
      durationMs,
      costUsd: null,
      summary: `AI Search unreachable — ${pairLabel}`,
      error: (err as Error).message,
      metadata: null,
    }).catch(() => {});
    return null;
  }
}

/**
 * Match multiple event pairs using search-grounded AI (DeepSeek + Vertex/Brave).
 *
 * Automatically chunks inputs larger than 20 pairs into sequential requests.
 */
export async function matchBatch(
  pairs: Array<{ event_a: AiSearchEventInfo; event_b: AiSearchEventInfo }>,
): Promise<AiSearchBatchResult | null> {
  if (pairs.length === 0) {
    return { verdicts: [], sources: [], searchQueriesUsed: [], model: "" };
  }

  const t0 = Date.now();

  if (pairs.length <= MAX_BATCH_SIZE) {
    try {
      const engine = getGroundingEngine();
      const result = await engine.matchBatch(
        pairs.map((p) => ({
          eventA: toEventInfo(p.event_a),
          eventB: toEventInfo(p.event_b),
        })),
      );

      const durationMs = Date.now() - t0;
      const same = result.verdicts.filter((v) => v.decision === "SAME").length;
      const diff = result.verdicts.filter(
        (v) => v.decision === "DIFFERENT",
      ).length;
      recordAiActivity({
        system: "entity-match",
        trigger: "batch",
        status: "success",
        model: result.model,
        itemCount: pairs.length,
        durationMs,
        costUsd: null,
        summary: `AI Search batch: ${pairs.length} pairs → ${same} SAME, ${diff} DIFFERENT`,
        error: null,
        metadata: {
          same,
          different: diff,
          sourcesCount: result.sources?.length ?? 0,
        },
      }).catch(() => {});

      return {
        verdicts: result.verdicts.map((v) => ({
          pair_index: v.pairIndex,
          decision: v.decision,
          confidence: v.confidence,
          reasoning: v.reasoning,
          diagnostics: v.diagnostics,
        })),
        sources: toSnakeCitations(result.sources),
        searchQueriesUsed: result.searchQueriesUsed,
        model: result.model,
      };
    } catch (err) {
      const durationMs = Date.now() - t0;
      logger.warn(tag, `matchBatch failed: ${(err as Error).message}`);
      recordAiActivity({
        system: "entity-match",
        trigger: "batch",
        status: "error",
        model: "deepseek-v4-flash",
        itemCount: pairs.length,
        durationMs,
        costUsd: null,
        summary: `AI Search batch failed (${pairs.length} pairs)`,
        error: (err as Error).message,
        metadata: null,
      }).catch(() => {});
      return null;
    }
  }

  // Multiple chunks — sequential calls, merge results
  const allVerdicts: AiSearchPairVerdict[] = [];
  const allSources: AiSearchSourceCitation[] = [];
  const allQueries: string[] = [];
  let model = "";

  for (let i = 0; i < pairs.length; i += MAX_BATCH_SIZE) {
    const chunk = pairs.slice(i, i + MAX_BATCH_SIZE);
    try {
      const engine = getGroundingEngine();
      const result = await engine.matchBatch(
        chunk.map((p) => ({
          eventA: toEventInfo(p.event_a),
          eventB: toEventInfo(p.event_b),
        })),
      );

      for (const v of result.verdicts) {
        allVerdicts.push({
          pair_index: v.pairIndex + i,
          decision: v.decision,
          confidence: v.confidence,
          reasoning: v.reasoning,
          diagnostics: v.diagnostics,
        });
      }
      allSources.push(...toSnakeCitations(result.sources));
      allQueries.push(...result.searchQueriesUsed);
      model = result.model;
    } catch (err) {
      logger.warn(
        tag,
        `Batch chunk ${i / MAX_BATCH_SIZE + 1} failed, aborting batch`,
      );
      const durationMs = Date.now() - t0;
      recordAiActivity({
        system: "entity-match",
        trigger: "batch",
        status: "error",
        model: model || "deepseek-v4-flash",
        itemCount: pairs.length,
        durationMs,
        costUsd: null,
        summary: `AI Search batch chunk ${i / MAX_BATCH_SIZE + 1} failed (${pairs.length} pairs)`,
        error: (err as Error).message,
        metadata: {
          failedChunk: i / MAX_BATCH_SIZE + 1,
          processedSoFar: allVerdicts.length,
        },
      }).catch(() => {});
      return null;
    }
  }

  const durationMs = Date.now() - t0;
  const same = allVerdicts.filter((v) => v.decision === "SAME").length;
  const diff = allVerdicts.filter((v) => v.decision === "DIFFERENT").length;
  recordAiActivity({
    system: "entity-match",
    trigger: "batch",
    status: "success",
    model,
    itemCount: pairs.length,
    durationMs,
    costUsd: null,
    summary: `AI Search batch: ${pairs.length} pairs → ${same} SAME, ${diff} DIFFERENT`,
    error: null,
    metadata: { same, different: diff, sourcesCount: allSources.length },
  }).catch(() => {});

  return {
    verdicts: allVerdicts,
    sources: allSources,
    searchQueriesUsed: [...new Set(allQueries)],
    model,
  };
}

/**
 * Probe whether the AI grounding engine is healthy.
 */
export async function checkHealth(): Promise<{
  ok: boolean;
  model?: string;
} | null> {
  try {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    return {
      ok: Boolean(apiKey),
      model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    };
  } catch {
    return null;
  }
}
