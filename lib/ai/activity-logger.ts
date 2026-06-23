
import { recordAiLog } from "@/lib/db/repositories/ai-logs";
import {
  incrementUsage,
  hasQuota,
} from "@/lib/db/repositories/ai-provider-config";
import { logger } from "@/lib/shared/logger";

const tag = "AiActivity";


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

  if (!(await hasQuota(provider))) {
    logger.warn(tag, `${provider} quota exhausted, rejecting ${endpoint}`);
    throw new Error(`${provider} quota exhausted`);
  }

  try {
    const result = await fn();

    await incrementUsage(provider);
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
