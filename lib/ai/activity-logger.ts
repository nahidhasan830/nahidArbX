/**
 * Unified Activity Logger — middleware for all AI operations.
 *
 * Captures both LLM and Search providers with a single schema:
 * - system:    'search' | 'llm'
 * - trigger:   'manual' | 'auto' | 'scheduler' | 'playground'
 * - status:   'success' | 'error' | 'partial'
 * - endpoint: specific operation type (e.g., 'grounding', 'entity-match', 'generate')
 *
 * Usage:
 *   const result = await withAiActivity('search', 'brave', 'grounding', async () => {
 *     return await braveProvider.search(query, maxResults);
 *   });
 */

import { recordAiLog } from "@/lib/db/repositories/ai-logs";
import {
  incrementUsage,
  hasQuota,
} from "@/lib/db/repositories/ai-provider-config";
import { logger } from "@/lib/shared/logger";

const tag = "AiActivity";

// ── Types ────────────────────────────────────────────────────────────

export type AiSystem = "search" | "llm";
export type AiTrigger =
  | "manual"
  | "auto"
  | "scheduler"
  | "playground"
  | "test"
  | string;

export interface AiActivityOptions {
  system: AiSystem;
  provider: string;
  endpoint: string;
  trigger?: AiTrigger;
  model?: string;
  query?: string;
  itemCount?: number;
  costUsd?: string | number;
  request?: unknown;
  response?: unknown | ((result: unknown) => unknown);
  metadata?: unknown;
}

// ── Helpers ─────────────────────────────────────────────────────────

function toLogValue<T>(value: T | undefined, fallback: T): T {
  return value !== undefined ? value : fallback;
}

function resolvePayload<T>(
  payload: unknown | ((result: T) => unknown),
  result: T,
): unknown {
  return typeof payload === "function"
    ? (payload as (result: T) => unknown)(result)
    : payload;
}

// ── Core functions ─────────────────────────────────────────────

/**
 * Wrap an AI call with quota checking + activity logging.
 * - Fails fast if quota exhausted
 * - Always logs outcome (success or error)
 */
export async function withAiActivity<T>(
  options: AiActivityOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const startTime = Date.now();
  const {
    system,
    provider,
    endpoint,
    trigger = "manual",
    model,
    query,
    itemCount,
    costUsd,
    request,
    response,
    metadata,
  } = options;

  // 1. Check quota before call
  if (!(await hasQuota(provider))) {
    logger.warn(tag, `${provider} quota exhausted, rejecting ${endpoint}`);
    throw new Error(`${provider} quota exhausted`);
  }

  try {
    // 2. Execute the AI call
    const result = await fn();

    // 3. Increment usage (ignores failure - quota already checked)
    await incrementUsage(provider);
    const durationMs = Date.now() - startTime;

    // 4. Log success with response
    await recordAiLog({
      system,
      trigger,
      endpoint,
      status: "success",
      model: model ?? provider,
      providerUsed: provider,
      itemCount: toLogValue(itemCount, 1),
      durationMs,
      costUsd: costUsd !== undefined ? String(costUsd) : null,
      query: query ?? null,
      summary: `${provider} ${endpoint} succeeded`,
      error: null,
      requestBody: request ?? null,
      responseBody:
        response !== undefined ? resolvePayload(response, result) : null,
      metadata: metadata ?? null,
    });

    return result;
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const error = err instanceof Error ? err.message : String(err);

    // Log error (still record for audit)
    await recordAiLog({
      system,
      trigger,
      endpoint,
      status: "error",
      model: model ?? provider,
      providerUsed: provider,
      itemCount: toLogValue(itemCount, 0),
      durationMs,
      costUsd: costUsd !== undefined ? String(costUsd) : null,
      query: query ?? null,
      summary: `${provider} ${endpoint} failed`,
      error,
      requestBody: request ?? null,
      responseBody: null,
      metadata: metadata ?? null,
    });

    // Re-throw so caller knows it failed
    throw err;
  }
}

/**
 * Lightweight wrapper - only logs activity, assumes quota already handled.
 * Use when provider has its own quota logic.
 */
export async function logAiActivity<T>(
  options: AiActivityOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const startTime = Date.now();
  const {
    system,
    provider,
    endpoint,
    trigger = "manual",
    model,
    query,
    itemCount,
    costUsd,
    request,
    response,
    metadata,
  } = options;

  try {
    const result = await fn();
    const durationMs = Date.now() - startTime;

    await recordAiLog({
      system,
      trigger,
      endpoint,
      status: "success",
      model: model ?? provider,
      providerUsed: provider,
      itemCount: toLogValue(itemCount, 1),
      durationMs,
      costUsd: costUsd !== undefined ? String(costUsd) : null,
      query: query ?? null,
      summary: `${provider} ${endpoint} succeeded`,
      error: null,
      requestBody: request ?? null,
      responseBody:
        response !== undefined ? resolvePayload(response, result) : null,
      metadata: metadata ?? null,
    });

    return result;
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const error = err instanceof Error ? err.message : String(err);

    await recordAiLog({
      system,
      trigger,
      endpoint,
      status: "error",
      model: model ?? provider,
      providerUsed: provider,
      itemCount: toLogValue(itemCount, 0),
      durationMs,
      costUsd: costUsd !== undefined ? String(costUsd) : null,
      query: query ?? null,
      summary: `${provider} ${endpoint} failed`,
      error,
      requestBody: request ?? null,
      responseBody: null,
      metadata: metadata ?? null,
    });

    throw err;
  }
}
