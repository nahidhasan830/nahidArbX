/**
 * Base Atoms Adapter
 *
 * Abstract base class for provider-specific odds fetching adapters.
 * Provides common functionality:
 * - Error handling with consistent logging
 * - Odds storage via setOddsBatch
 * - Debug capture via DebugFetcher utility
 *
 * Subclasses must implement:
 * - providerId: Provider identifier
 * - fetchRawData(): Provider-specific API call
 * - extractOdds(): Provider-specific odds extraction
 *
 * Optional override:
 * - captureDebugRequest(): Customize how requests are captured for debug
 * - debugFetchRawData(): Customize raw data fetching for debug mode
 */

import { setOddsBatch } from "../store";
import { formatError } from "../../shared/errors";
import { DebugFetcher } from "../../shared/debug-fetcher";
import type { NormalizedOddsEntry, ProviderKey } from "../types";
import type { DebugFetchResult } from "./debug-fetch";

/**
 * Context passed to fetch methods.
 * Contains all information needed to fetch and store odds.
 */
export interface FetchContext {
  providerEventId: string;
  normalizedEventId: string;
  homeTeam: string;
  awayTeam: string;
}

/**
 * Base class for atoms adapters.
 * Extend this class and implement the abstract methods.
 */
export abstract class BaseAtomsAdapter {
  /** Provider identifier (e.g., "pinnacle", "ninewickets-exchange") */
  abstract readonly providerId: ProviderKey;

  /**
   * Fetch raw data from the provider API.
   * Override to implement provider-specific API call.
   *
   * @returns Raw API response data, or null if fetch failed
   */
  protected abstract fetchRawData(ctx: FetchContext): Promise<unknown>;

  /**
   * Extract normalized odds entries from raw API data.
   * Override to implement provider-specific extraction logic.
   *
   * @param rawData - Raw data returned from fetchRawData
   * @param ctx - Fetch context with event info
   * @returns Array of normalized odds entries
   */
  protected abstract extractOdds(
    rawData: unknown,
    ctx: FetchContext,
  ): NormalizedOddsEntry[];

  /**
   * Fetch and store odds for an event.
   * Standard implementation - no override needed.
   */
  async fetchAndStoreOdds(
    providerEventId: string,
    normalizedEventId: string,
    homeTeam: string,
    awayTeam: string,
  ): Promise<number> {
    const ctx: FetchContext = {
      providerEventId,
      normalizedEventId,
      homeTeam,
      awayTeam,
    };

    try {
      const rawData = await this.fetchRawData(ctx);
      if (!rawData) return 0;

      const entries = this.extractOdds(rawData, ctx);

      if (entries.length > 0) {
        setOddsBatch(entries);
      }

      return entries.length;
    } catch (error) {
      console.warn(
        `[${this.providerId}] Error for event ${providerEventId}:`,
        formatError(error),
      );
      return 0;
    }
  }

  /**
   * Capture debug request info before fetching.
   * Override to customize request capture (e.g., add label, body, headers).
   *
   * @param debug - DebugFetcher instance to add request to
   * @param ctx - Fetch context
   */
  // Subclasses override this; params intentionally unused in base
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected captureDebugRequest(debug: DebugFetcher, ctx: FetchContext): void {
    // Default: no request capture (subclass should override)
  }

  /**
   * Fetch raw data in debug mode.
   * Override to use DebugFetcher's executeWithCapture for response capture.
   *
   * Default implementation calls fetchRawData (no response capture).
   */
  protected async debugFetchRawData(
    debug: DebugFetcher,
    ctx: FetchContext,
  ): Promise<unknown> {
    // Default: just call regular fetchRawData
    // Subclass should override to use debug.executeWithCapture()
    return this.fetchRawData(ctx);
  }

  /**
   * Debug version of fetchAndStoreOdds.
   * Captures request/response data for debugging UI.
   */
  async debugFetchAndStoreOdds(
    providerEventId: string,
    normalizedEventId: string,
    homeTeam: string,
    awayTeam: string,
  ): Promise<DebugFetchResult> {
    const ctx: FetchContext = {
      providerEventId,
      normalizedEventId,
      homeTeam,
      awayTeam,
    };

    const debug = new DebugFetcher(
      this.providerId,
      providerEventId,
      normalizedEventId,
    );

    try {
      // Capture request
      this.captureDebugRequest(debug, ctx);

      // Fetch with capture
      const rawData = await this.debugFetchRawData(debug, ctx);
      if (!rawData) return debug.getResult();

      // Extract odds
      const entries = this.extractOdds(rawData, ctx);

      // Store odds
      if (entries.length > 0) {
        setOddsBatch(entries);
      }

      return debug.finalize(entries);
    } catch (error) {
      console.warn(
        `[${this.providerId} Debug] Error for event ${providerEventId}:`,
        formatError(error),
      );
      return debug.getResult();
    }
  }
}
