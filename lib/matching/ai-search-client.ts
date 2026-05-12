/**
 * HTTP client for the local AI Search service (services/ai-search).
 *
 * Talks to the FastAPI gateway at `AI_SEARCH_URL` (default localhost:8090).
 * Provides typed wrappers for:
 *   - /entity-match       — single-pair grounded matching
 *   - /entity-match-batch — batch matching (up to 20 pairs per call)
 *   - /healthz            — service health probe
 *
 * Failure mode: every call returns `null` on timeout or non-2xx. Callers
 * treat `null` as "service unavailable → fall through to human_review".
 * The sync hot path never throws because of an AI Search outage.
 */

import { logger } from "../shared/logger";
import { recordAiActivity } from "../db/repositories/ai-activity-log";

const tag = "AiSearchClient";

/** Batch endpoint accepts at most 20 pairs per call. */
const MAX_BATCH_SIZE = 20;

/** Single-pair calls run search + LLM — allow up to 60 s. */
const SINGLE_TIMEOUT_MS = 60_000;

/** Batch calls do search + a single bigger LLM prompt — scale timeout. */
const BATCH_BASE_TIMEOUT_MS = 30_000;
const BATCH_PER_PAIR_MS = 3_000;

// ─── Types ─────────────────────────────────────────────────────────────

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
  search_queries_used: string[];
  model: string;
}

export interface AiSearchPairVerdict {
  pair_index: number;
  decision: "SAME" | "DIFFERENT" | "UNCERTAIN";
  confidence: number; // 0-100
  reasoning: string;
}

export interface AiSearchBatchResult {
  verdicts: AiSearchPairVerdict[];
  sources: AiSearchSourceCitation[];
  search_queries_used: string[];
  model: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function baseUrl(): string {
  return (process.env.AI_SEARCH_URL || "http://localhost:8090").replace(
    /\/$/,
    "",
  );
}

async function postJson<T>(
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<T | null> {
  const url = `${baseUrl()}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logger.warn(tag, `${path} returned ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      logger.warn(tag, `${path} failed: ${(err as Error).message}`);
    } else {
      logger.warn(tag, `${path} timed out after ${timeoutMs}ms`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Match a single event pair using search-grounded AI.
 *
 * Returns a verdict with web evidence citations, or `null` if the
 * service is unreachable.
 *
 * @param llmProvider - If set, force a specific LLM engine ("huggingface", "groq")
 */
export async function matchSingle(
  eventA: AiSearchEventInfo,
  eventB: AiSearchEventInfo,
  opts?: { llmProvider?: string },
): Promise<AiSearchMatchVerdict | null> {
  const t0 = Date.now();
  const pairLabel = `${eventA.home_team} v ${eventA.away_team} vs ${eventB.home_team} v ${eventB.away_team}`;

  const body: Record<string, unknown> = {
    event_a: eventA,
    event_b: eventB,
  };
  if (opts?.llmProvider) {
    body.llm_provider = opts.llmProvider;
  }

  const result = await postJson<AiSearchMatchVerdict>(
    "/entity-match",
    body,
    SINGLE_TIMEOUT_MS,
  );

  const durationMs = Date.now() - t0;
  recordAiActivity({
    system: "entity-match",
    trigger: "manual",
    status: result ? "success" : "error",
    model: result?.model ?? "llama-3.3-70b-versatile",
    itemCount: 1,
    durationMs,
    costUsd: null,
    summary: result
      ? `AI Search single: ${result.decision} ${result.confidence}% — ${pairLabel}`
      : `AI Search unreachable — ${pairLabel}`,
    error: result ? null : "Service unreachable or timeout",
    metadata: result
      ? {
          decision: result.decision,
          confidence: result.confidence,
          sourcesCount: result.sources?.length ?? 0,
        }
      : null,
  }).catch(() => {});

  return result;
}

/**
 * Match multiple event pairs in a single grounded AI call.
 *
 * Deduplicates search queries across all pairs and sends a single
 * prompt to the LLM for all verdicts. Automatically chunks inputs
 * larger than 20 pairs into sequential requests.
 *
 * Returns `null` if the service is unreachable.
 */
export async function matchBatch(
  pairs: Array<{ event_a: AiSearchEventInfo; event_b: AiSearchEventInfo }>,
): Promise<AiSearchBatchResult | null> {
  if (pairs.length === 0) {
    return { verdicts: [], sources: [], search_queries_used: [], model: "" };
  }

  const t0 = Date.now();

  // Single chunk — call directly
  if (pairs.length <= MAX_BATCH_SIZE) {
    const timeoutMs = BATCH_BASE_TIMEOUT_MS + pairs.length * BATCH_PER_PAIR_MS;
    const result = await postJson<AiSearchBatchResult>(
      "/entity-match-batch",
      { pairs },
      timeoutMs,
    );

    const durationMs = Date.now() - t0;
    const same =
      result?.verdicts.filter((v) => v.decision === "SAME").length ?? 0;
    const diff =
      result?.verdicts.filter((v) => v.decision === "DIFFERENT").length ?? 0;
    recordAiActivity({
      system: "entity-match",
      trigger: "batch",
      status: result ? "success" : "error",
      model: result?.model ?? "llama-3.3-70b-versatile",
      itemCount: pairs.length,
      durationMs,
      costUsd: null,
      summary: result
        ? `AI Search batch: ${pairs.length} pairs → ${same} SAME, ${diff} DIFFERENT`
        : `AI Search batch unreachable (${pairs.length} pairs)`,
      error: result ? null : "Service unreachable or timeout",
      metadata: result
        ? { same, different: diff, sourcesCount: result.sources?.length ?? 0 }
        : null,
    }).catch(() => {});

    return result;
  }

  // Multiple chunks — sequential calls, merge results
  const allVerdicts: AiSearchPairVerdict[] = [];
  const allSources: AiSearchSourceCitation[] = [];
  const allQueries: string[] = [];
  let model = "";

  for (let i = 0; i < pairs.length; i += MAX_BATCH_SIZE) {
    const chunk = pairs.slice(i, i + MAX_BATCH_SIZE);
    const timeoutMs = BATCH_BASE_TIMEOUT_MS + chunk.length * BATCH_PER_PAIR_MS;
    const result = await postJson<AiSearchBatchResult>(
      "/entity-match-batch",
      { pairs: chunk },
      timeoutMs,
    );

    if (!result) {
      logger.warn(
        tag,
        `Batch chunk ${i / MAX_BATCH_SIZE + 1} failed, aborting batch`,
      );

      const durationMs = Date.now() - t0;
      recordAiActivity({
        system: "entity-match",
        trigger: "batch",
        status: "error",
        model: model || "llama-3.3-70b-versatile",
        itemCount: pairs.length,
        durationMs,
        costUsd: null,
        summary: `AI Search batch chunk ${i / MAX_BATCH_SIZE + 1} failed (${pairs.length} pairs)`,
        error: "Chunk failed, aborting batch",
        metadata: {
          failedChunk: i / MAX_BATCH_SIZE + 1,
          processedSoFar: allVerdicts.length,
        },
      }).catch(() => {});

      return null;
    }

    for (const v of result.verdicts) {
      allVerdicts.push({
        ...v,
        pair_index: v.pair_index + i,
      });
    }
    allSources.push(...result.sources);
    allQueries.push(...result.search_queries_used);
    model = result.model;
  }

  const merged: AiSearchBatchResult = {
    verdicts: allVerdicts,
    sources: allSources,
    search_queries_used: [...new Set(allQueries)],
    model,
  };

  const durationMs = Date.now() - t0;
  const same = allVerdicts.filter((v) => v.decision === "SAME").length;
  const diff = allVerdicts.filter((v) => v.decision === "DIFFERENT").length;
  recordAiActivity({
    system: "entity-match",
    trigger: "batch",
    status: "success",
    model: model || "llama-3.3-70b-versatile",
    itemCount: pairs.length,
    durationMs,
    costUsd: null,
    summary: `AI Search batch: ${pairs.length} pairs → ${same} SAME, ${diff} DIFFERENT`,
    error: null,
    metadata: { same, different: diff, sourcesCount: allSources.length },
  }).catch(() => {});

  return merged;
}

// ─── Settlement score lookup ──────────────────────────────────────

export interface AiSettlementVerdict {
  answer: string;
  confidence: number; // 0-100
  reasoning: string;
  sources: AiSearchSourceCitation[];
  model: string;
}

/**
 * Ask the AI Search service to look up the final score of a match
 * by searching the web and reasoning about the result.
 *
 * This is the missing link: for niche leagues (Brazil Serie C, etc.)
 * that ESPN/API-Football/SofaScore can't resolve, HuggingFace+Search can
 * find the result on FlashScore, Google Sports, or news sites.
 *
 * Returns `null` if the service is unreachable or times out.
 */
export async function verifySettlement(
  event: AiSearchEventInfo,
  question: string,
): Promise<AiSettlementVerdict | null> {
  const t0 = Date.now();
  const label = `${event.home_team} v ${event.away_team}`;

  const result = await postJson<AiSettlementVerdict>(
    "/verify-settlement",
    { event, question },
    SINGLE_TIMEOUT_MS,
  );

  const durationMs = Date.now() - t0;
  recordAiActivity({
    system: "settlement-score-lookup",
    trigger: "waterfall",
    status: result ? "success" : "error",
    model: result?.model ?? "llama-3.3-70b-versatile",
    itemCount: 1,
    durationMs,
    costUsd: null,
    summary: result
      ? `AI Search settlement: "${result.answer}" ${result.confidence}% — ${label}`
      : `AI Search settlement unreachable — ${label}`,
    error: result ? null : "Service unreachable or timeout",
    metadata: result
      ? {
          answer: result.answer,
          confidence: result.confidence,
          sourcesCount: result.sources?.length ?? 0,
        }
      : null,
  }).catch(() => {});

  return result;
}

/**
 * Probe whether the AI Search service is reachable and healthy.
 */
export async function checkHealth(): Promise<{
  ok: boolean;
  model?: string;
} | null> {
  const url = `${baseUrl()}/healthz`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as {
      status?: string;
      llm_engine?: { model?: string };
    };
    return {
      ok: data.status === "ok",
      model: data.llm_engine?.model,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
