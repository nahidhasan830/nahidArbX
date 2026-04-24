/**
 * Pinnacle Atoms Adapter
 *
 * Fetches raw market data from Pinnacle and extracts odds directly into atoms store.
 * Uses shared schemas and client from lib/adapters/pinnacle/ module.
 */

import { BaseAtomsAdapter, type FetchContext } from "./base";
import { DebugFetcher } from "../../shared/debug-fetcher";
import { validateAndParse } from "../../shared/validation";
import { formatError } from "../../shared/errors";
import { logger } from "../../shared/logger";
import {
  extractPinnacleOdds,
  type PinnacleMarketTuple,
  type ScoreContext,
  type CornersScoreContext,
} from "../mappings/pinnacle";
import type { NormalizedOddsEntry, ProviderKey } from "../types";
import { getLiveScore, getCornersScore } from "../../scores/store";
import { getMultiSourceScore } from "../../scores/multi-source-store";

import {
  SOCCER_SPORT_ID,
  PinnacleEventMarketsResponseSchema,
  fetchWithTokenRefresh,
  type PinnacleEventMarketsResponse,
  type PinnacleMarket,
} from "../../adapters/pinnacle/index";
import { buildEventMarketsUrl } from "../../adapters/pinnacle/urls";
import { config } from "../../config";

// Re-export for backward compatibility
export {
  SOCCER_SPORT_ID,
  PinnacleEventMarketsResponseSchema,
} from "../../adapters/pinnacle/schemas";
export { buildEventMarketsUrl } from "../../adapters/pinnacle/urls";

// ============================================
// Types
// ============================================

export interface PinnacleFetchOptions {
  fastMode?: boolean;
}

interface PinnacleRawData {
  parsed: PinnacleEventMarketsResponse;
  providerEventId: string;
}

// ============================================
// Adapter Class
// ============================================

export class PinnacleAtomsAdapter extends BaseAtomsAdapter {
  readonly providerId: ProviderKey = "pinnacle";

  private options?: PinnacleFetchOptions;

  setOptions(options: PinnacleFetchOptions): void {
    this.options = options;
  }

  protected async fetchRawData(
    ctx: FetchContext,
  ): Promise<PinnacleRawData | null> {
    const url = buildEventMarketsUrl(ctx.providerEventId);
    const { data } = await fetchWithTokenRefresh(url, {
      timeout: 10000,
      fastMode: this.options?.fastMode,
    });

    const parsed = validateAndParse(
      data,
      PinnacleEventMarketsResponseSchema,
      `[Pinnacle Atoms] event ${ctx.providerEventId}`,
    );

    if (!parsed) return null;

    if (parsed.code !== 200) {
      logger.error(
        "PinnacleAtoms",
        `API error for event ${ctx.providerEventId}: ${parsed.message}`,
      );
      return null;
    }

    return { parsed, providerEventId: ctx.providerEventId };
  }

  protected extractOdds(
    rawData: unknown,
    ctx: FetchContext,
  ): NormalizedOddsEntry[] {
    const { parsed, providerEventId } = rawData as PinnacleRawData;
    const allEntries: NormalizedOddsEntry[] = [];
    let rawMarketCount = 0;

    // Get live score for handicap adjustment
    // Try multi-source store first (has fallback to BC), then legacy Pinnacle-only store
    // SPREAD markets will be adjusted from "running ball" to "full match" semantics
    let scoreContext: ScoreContext | undefined;
    let cornersScoreContext: CornersScoreContext | undefined;

    // Try multi-source store (keyed by normalized event ID)
    const multiScore = getMultiSourceScore(ctx.normalizedEventId);
    if (multiScore?.primary) {
      scoreContext = {
        homeScore: multiScore.primary.homeScore,
        awayScore: multiScore.primary.awayScore,
      };

      // Log warning if using low-confidence score
      if (multiScore.confidence === "low") {
        logger.warn(
          "PinnacleAtoms",
          `Using low-confidence score for ${ctx.normalizedEventId}: ` +
            `${multiScore.primary.homeScore}-${multiScore.primary.awayScore} from ${multiScore.primary.source}`,
        );
      }

      // Extract corners from multi-source if available
      if (multiScore.primary.homeCorners !== undefined) {
        cornersScoreContext = {
          homeCorners: multiScore.primary.homeCorners,
          awayCorners: multiScore.primary.awayCorners || 0,
        };
      }
    }

    // Fallback to legacy Pinnacle-only store (keyed by Pinnacle event ID)
    if (!scoreContext) {
      const liveScore = getLiveScore(providerEventId);
      if (liveScore) {
        scoreContext = {
          homeScore: liveScore.homeScore,
          awayScore: liveScore.awayScore,
        };
      }
    }

    // Get corners from legacy store if not from multi-source
    if (!cornersScoreContext) {
      const cornersLiveScore = getCornersScore(providerEventId);
      if (cornersLiveScore) {
        cornersScoreContext = {
          homeCorners: cornersLiveScore.homeCorners,
          awayCorners: cornersLiveScore.awayCorners,
        };
      }
    }

    for (const sport of parsed.data) {
      if (sport[0] !== SOCCER_SPORT_ID) continue;

      const leagues = sport[3];
      for (const league of leagues) {
        const rawEvents = league[2];
        for (const rawEvent of rawEvents) {
          const periods = rawEvent[5];
          for (const period of periods) {
            const hasMarkets = period[4];
            if (!hasMarkets) continue;

            const rawMarkets = period[5] as PinnacleMarket[];
            rawMarketCount += rawMarkets.length;
            for (const market of rawMarkets) {
              const entries = extractPinnacleOdds(
                market as PinnacleMarketTuple,
                ctx.normalizedEventId,
                scoreContext, // Pass score for live handicap adjustment
                cornersScoreContext, // Pass corners score for corners handicap adjustment
              );
              allEntries.push(...entries);
            }
          }
        }
      }
    }

    // Log only when extraction fails
    if (allEntries.length === 0 && rawMarketCount > 0) {
      logger.warn(
        "PinnacleAtoms",
        `Event ${providerEventId}: ${rawMarketCount} raw markets but 0 odds extracted!`,
      );
    }

    return allEntries;
  }

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
        const { setOddsBatch } = await import("../store");
        setOddsBatch(entries);
      }

      return entries.length;
    } catch (error) {
      // In fast mode, token expired errors are expected - skip silently
      if (
        this.options?.fastMode &&
        error instanceof Error &&
        error.message.includes("fast mode")
      ) {
        // Skip silently in fast mode
      } else {
        logger.error(
          "PinnacleAtoms",
          `Error for event ${providerEventId}: ${formatError(error)}`,
        );
      }
      return 0;
    }
  }

  protected captureDebugRequest(debug: DebugFetcher, ctx: FetchContext): void {
    const urlPath = buildEventMarketsUrl(ctx.providerEventId);
    const fullUrl = `${config.providers.pinnacle.baseUrl}${urlPath}`;

    debug.captureRequest({
      url: fullUrl,
      method: "GET",
      headers: { Authorization: "Bearer [REDACTED]" },
    });
  }

  protected async debugFetchRawData(
    debug: DebugFetcher,
    ctx: FetchContext,
  ): Promise<PinnacleRawData | null> {
    const urlPath = buildEventMarketsUrl(ctx.providerEventId);

    const startTime = Date.now();
    try {
      const { data } = await fetchWithTokenRefresh(urlPath, { timeout: 10000 });
      const durationMs = Date.now() - startTime;

      debug.addResponse({
        status: 200,
        data,
        durationMs,
      });

      const parsed = validateAndParse(
        data,
        PinnacleEventMarketsResponseSchema,
        `[Pinnacle Debug] event ${ctx.providerEventId}`,
      );

      if (!parsed || parsed.code !== 200) return null;

      return { parsed, providerEventId: ctx.providerEventId };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      debug.addResponse({
        status: 500,
        data: { error: formatError(error) },
        durationMs,
      });
      return null;
    }
  }
}

// ============================================
// Singleton instance
// ============================================

const adapterInstance = new PinnacleAtomsAdapter();

// ============================================
// Legacy Function Exports (Backward Compatibility)
// ============================================

export async function fetchAndStorePinnacleOdds(
  providerEventId: string,
  normalizedEventId: string,
  homeTeam: string,
  awayTeam: string,
  options?: PinnacleFetchOptions,
): Promise<number> {
  if (options) {
    adapterInstance.setOptions(options);
  }
  return adapterInstance.fetchAndStoreOdds(
    providerEventId,
    normalizedEventId,
    homeTeam,
    awayTeam,
  );
}

export async function debugFetchAndStorePinnacleOdds(
  providerEventId: string,
  normalizedEventId: string,
  homeTeam: string,
  awayTeam: string,
) {
  return adapterInstance.debugFetchAndStoreOdds(
    providerEventId,
    normalizedEventId,
    homeTeam,
    awayTeam,
  );
}
