import { logger } from "../../shared/logger";
import {
  extractPinnacleOdds,
  type PinnacleMarketTuple,
  type ScoreContext,
  type CornersScoreContext,
} from "../../atoms/mappings/pinnacle";
import type { NormalizedOddsEntry } from "../../atoms/types";
import { getMultiSourceScore } from "../../scores/multi-source-store";
import { getLiveScore, getCornersScore } from "../../scores/store";

export interface PinnacleWsParseResult {
  entries: NormalizedOddsEntry[];
  isSnapshot: boolean;
}

const EMPTY_RESULT: PinnacleWsParseResult = { entries: [], isSnapshot: false };

export function parsePinnacleWsMessage(
  destination: string,
  body: string,
  providerEventId: string,
  normalizedEventId: string,
): PinnacleWsParseResult {
  if (!destination.includes("/market/decimal/")) {
    return EMPTY_RESULT;
  }

  if (!body || body.length === 0) {
    return EMPTY_RESULT;
  }

  let payload: unknown[];
  try {
    payload = JSON.parse(body);
  } catch (_err) {
    logger.error(
      "PinnacleWs",
      `Failed to parse WS payload for ${providerEventId} (len=${body.length})`,
    );
    return EMPTY_RESULT;
  }

  if (!Array.isArray(payload)) {
    return EMPTY_RESULT;
  }

  let scoreContext: ScoreContext | undefined;
  let cornersScoreContext: CornersScoreContext | undefined;

  const multiScore = getMultiSourceScore(normalizedEventId);
  if (multiScore?.primary) {
    scoreContext = {
      homeScore: multiScore.primary.homeScore,
      awayScore: multiScore.primary.awayScore,
    };
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

  const allEntries: NormalizedOddsEntry[] = [];

  for (const item of payload) {
    if (!Array.isArray(item) || item.length < 19) continue;

    const entries = extractPinnacleOdds(
      item as PinnacleMarketTuple,
      normalizedEventId,
      scoreContext,
      cornersScoreContext,
    );
    allEntries.push(...entries);
  }

  return { entries: allEntries, isSnapshot: true };
}
