/**
 * Debug Fetcher Utility
 *
 * Reusable class for capturing HTTP request/response data during debug fetching.
 * Eliminates 400+ lines of duplicated debug capture logic across adapters.
 */

import type { AxiosResponse } from "axios";
import { formatError } from "./errors";
import type { ProviderKey } from "../providers/registry";
import type {
  DebugFetchResult,
  DebugHttpRequest,
  DebugHttpResponse,
} from "../atoms/adapters/debug-fetch";
import type { NormalizedOddsEntry } from "../atoms/types";

/**
 * DebugFetcher captures request/response data for debugging UI.
 *
 * Usage:
 * ```typescript
 * const debug = new DebugFetcher("pinnacle", providerEventId, normalizedEventId);
 *
 * debug.captureRequest({ url: "...", method: "GET", headers: { ... } });
 * const data = await debug.executeWithCapture(() => client.get(url));
 *
 * if (data) {
 *   const entries = extractOdds(data);
 *   return debug.finalize(entries);
 * }
 * return debug.getResult();
 * ```
 */
export class DebugFetcher {
  private result: DebugFetchResult;

  constructor(
    provider: ProviderKey,
    providerEventId: string,
    canonicalEventId: string,
  ) {
    this.result = {
      internalPayload: {
        provider,
        providerEventId,
        canonicalEventId,
      },
      providerRequests: [],
      rawResponses: [],
      normalizedOdds: [],
      oddsCount: 0,
    };
  }

  /**
   * Capture a request before execution.
   * Call this before executeWithCapture for proper ordering.
   */
  captureRequest(opts: {
    label?: string;
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
  }): void {
    const request: DebugHttpRequest = {
      url: opts.url,
      method: opts.method,
      headers: opts.headers ?? {},
    };
    if (opts.label) request.label = opts.label;
    if (opts.body) request.body = opts.body;

    this.result.providerRequests.push(request);
  }

  /**
   * Execute an async operation and capture the response.
   * Automatically tracks timing and handles errors.
   *
   * @returns Response data or null if request failed
   */
  async executeWithCapture<T>(
    executor: () => Promise<AxiosResponse<T>>,
  ): Promise<T | null> {
    const startTime = Date.now();
    try {
      const response = await executor();
      const durationMs = Date.now() - startTime;

      this.result.rawResponses.push({
        status: response.status,
        data: response.data,
        durationMs,
      });

      return response.data;
    } catch (error) {
      const durationMs = Date.now() - startTime;

      this.result.rawResponses.push({
        status: 500,
        data: { error: formatError(error) },
        durationMs,
      });

      return null;
    }
  }

  /**
   * Manually add a response (for cases where executeWithCapture can't be used).
   */
  addResponse(response: DebugHttpResponse): void {
    this.result.rawResponses.push(response);
  }

  /**
   * Finalize the result with extracted odds entries.
   * Use this at the end of a successful debug fetch.
   */
  finalize(entries: NormalizedOddsEntry[]): DebugFetchResult {
    this.result.normalizedOdds = entries;
    this.result.oddsCount = entries.length;
    return this.result;
  }

  /**
   * Get the current result (use when you can't finalize normally).
   */
  getResult(): DebugFetchResult {
    return this.result;
  }
}
