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
  /**
   * True when the payload parsed as a full market snapshot (non-empty
   * JSON array). The caller should then apply it via
   * `applyProviderSnapshot` so dropped markets are pruned. False for
   * empty bodies / non-odds destinations / parse failures — those must
   * NOT clear existing odds.
   */
  isSnapshot: boolean;
}

const EMPTY_RESULT: PinnacleWsParseResult = { entries: [], isSnapshot: false };

export function parsePinnacleWsMessage(
  destination: string,
  body: string,
  providerEventId: string,
  normalizedEventId: string,
): PinnacleWsParseResult {
  // We only parse odds from the /market/decimal/.../A destination
  if (!destination.includes("/market/decimal/")) {
    return EMPTY_RESULT;
  }

  // Pinnacle sends an empty body on initial subscription for events with
  // no active markets (ended / suspended / not yet open). Skip silently.
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

  // Get live score for handicap adjustment
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

  // payload is an array of PinnacleMarketTuple
  for (const item of payload) {
    // Basic validation of the tuple
    if (!Array.isArray(item) || item.length < 19) continue;

    const entries = extractPinnacleOdds(
      item as PinnacleMarketTuple,
      normalizedEventId,
      scoreContext,
      cornersScoreContext,
    );
    allEntries.push(...entries);
  }

  // A parsed array (even one extracting 0 entries) is a full snapshot:
  // markets absent from it were dropped by Pinnacle and must be pruned
  // by the caller via applyProviderSnapshot.
  return { entries: allEntries, isSnapshot: true };
}
