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

import { setOddsBatch, applyProviderSnapshot } from "../store";
import { formatError } from "../../shared/errors";
import type { NormalizedOddsEntry, ProviderKey } from "../types";
import type { AtomsFetchOptions } from "../../adapters/unified-registry";
import { logger } from "../../shared/logger";

/**
 * Context passed to fetch methods.
 * Contains all information needed to fetch and store odds.
 */
export interface FetchContext {
  providerEventId: string;
  normalizedEventId: string;
  homeTeam: string;
  awayTeam: string;
  options: AtomsFetchOptions;
  resolvedSelections?: Record<string, string>;
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
    options: AtomsFetchOptions = {},
  ): Promise<number> {
    const ctx: FetchContext = {
      providerEventId,
      normalizedEventId,
      homeTeam,
      awayTeam,
      options,
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
      logger.warn(
        "AtomsBase",
        `[${this.providerId}] Error for event ${providerEventId}: ${formatError(error)}`,
      );
      return 0;
    }
  }

  /**
   * Process and store raw odds data (used by continuous polling sync services).
   *
   * @param rawData - Raw data from the provider
   * @param ctx - Fetch context
   * @returns Number of odds entries extracted and stored
   */
  public processRawOdds(rawData: unknown, ctx: FetchContext): number {
    try {
      const entries = this.extractOdds(rawData, ctx);
      // Diff the snapshot against the store: atoms the provider dropped
      // from its feed are deleted; everything else flows through
      // setOdds' value comparison so unchanged prices don't mark
      // families dirty or inflate tick history.
      applyProviderSnapshot(ctx.normalizedEventId, this.providerId, entries);
      return entries.length;
    } catch (error) {
      logger.error(
        "AtomsBase",
        `[${this.providerId}] Error processing raw odds for event ${ctx.providerEventId}: ${formatError(error)}`,
      );
      return 0;
    }
  }
}
