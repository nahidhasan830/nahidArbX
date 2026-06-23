
import { BaseAtomsAdapter, type FetchContext } from "./base";

import { validateAndParse } from "../../shared/validation";

import { logger } from "../../shared/logger";
import {
  extractPinnacleOdds,
  type PinnacleMarketTuple,
  type ScoreContext,
  type CornersScoreContext,
} from "../mappings/pinnacle";
import type { NormalizedOddsEntry, ProviderKey } from "../types";
import type { AtomsFetchOptions } from "../../adapters/unified-registry";
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

export {
  SOCCER_SPORT_ID,
  PinnacleEventMarketsResponseSchema,
} from "../../adapters/pinnacle/schemas";
export { buildEventMarketsUrl } from "../../adapters/pinnacle/urls";


interface PinnacleRawData {
  parsed: PinnacleEventMarketsResponse;
  providerEventId: string;
}


export class PinnacleAtomsAdapter extends BaseAtomsAdapter {
  readonly providerId: ProviderKey = "pinnacle";

  protected async fetchRawData(
    ctx: FetchContext,
  ): Promise<PinnacleRawData | null> {
    const url = buildEventMarketsUrl(ctx.providerEventId);
    const { data } = await fetchWithTokenRefresh(url, {
      timeout: 10000,
      fastMode: ctx.options.fastMode,
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

    let scoreContext: ScoreContext | undefined;
    let cornersScoreContext: CornersScoreContext | undefined;

    const multiScore = getMultiSourceScore(ctx.normalizedEventId);
    if (multiScore?.primary) {
      scoreContext = {
        homeScore: multiScore.primary.homeScore,
        awayScore: multiScore.primary.awayScore,
      };

      if (multiScore.confidence === "low") {
        logger.warn(
          "PinnacleAtoms",
          `Using low-confidence score for ${ctx.normalizedEventId}: ` +
            `${multiScore.primary.homeScore}-${multiScore.primary.awayScore} from ${multiScore.primary.source}`,
        );
      }

      if (multiScore.primary.homeCorners !== undefined) {
        cornersScoreContext = {
          homeCorners: multiScore.primary.homeCorners,
          awayCorners: multiScore.primary.awayCorners || 0,
        };
      }
    }

    if (!scoreContext) {
      const liveScore = getLiveScore(providerEventId);
      if (liveScore) {
        scoreContext = {
          homeScore: liveScore.homeScore,
          awayScore: liveScore.awayScore,
        };
      }
    }

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
    _options: AtomsFetchOptions = {},
  ): Promise<number> {
    return 0;
  }
}


const adapterInstance = new PinnacleAtomsAdapter();


export async function fetchAndStorePinnacleOdds(
  providerEventId: string,
  normalizedEventId: string,
  homeTeam: string,
  awayTeam: string,
  options?: AtomsFetchOptions,
): Promise<number> {
  return adapterInstance.fetchAndStoreOdds(
    providerEventId,
    normalizedEventId,
    homeTeam,
    awayTeam,
    options,
  );
}
