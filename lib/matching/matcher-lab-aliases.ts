import { logger } from "../shared/logger";
import type { NormalizedEvent } from "../types";
import type { MatchPairRow } from "../db/schema";
import type { PreNormalizedNames } from "./normalize";
import { harvestMatchPair } from "./entities/match-harvester";
import { normalize, normalizeCompetition } from "./entities/normalize";

const tag = "MatcherLabAliases";

export async function learnAliasesForMatchPair(
  pair: Pick<
    MatchPairRow,
    | "id"
    | "eventAProvider"
    | "eventAHomeTeam"
    | "eventAAwayTeam"
    | "eventACompetition"
    | "eventAStartTime"
    | "eventAEventId"
    | "eventBProvider"
    | "eventBHomeTeam"
    | "eventBAwayTeam"
    | "eventBCompetition"
    | "eventBStartTime"
    | "eventBEventId"
    | "mlCombinedScore"
    | "stringScore"
  >,
): Promise<void> {
  try {
    const eventA: NormalizedEvent = {
      id: pair.eventAEventId ?? `lab-${pair.id}-a`,
      sport: "football",
      homeTeam: pair.eventAHomeTeam,
      awayTeam: pair.eventAAwayTeam,
      competition: pair.eventACompetition,
      startTime: new Date(pair.eventAStartTime),
      providers: {
        [pair.eventAProvider]: { eventId: pair.eventAEventId ?? "" },
      } as NormalizedEvent["providers"],
    };

    const eventB: NormalizedEvent = {
      id: pair.eventBEventId ?? `lab-${pair.id}-b`,
      sport: "football",
      homeTeam: pair.eventBHomeTeam,
      awayTeam: pair.eventBAwayTeam,
      competition: pair.eventBCompetition,
      startTime: new Date(pair.eventBStartTime),
      providers: {
        [pair.eventBProvider]: { eventId: pair.eventBEventId ?? "" },
      } as NormalizedEvent["providers"],
    };

    const preNormA: PreNormalizedNames = {
      home: normalize(pair.eventAHomeTeam),
      away: normalize(pair.eventAAwayTeam),
      competition: normalizeCompetition(pair.eventACompetition),
    };

    const preNormB: PreNormalizedNames = {
      home: normalize(pair.eventBHomeTeam),
      away: normalize(pair.eventBAwayTeam),
      competition: normalizeCompetition(pair.eventBCompetition),
    };

    await harvestMatchPair(
      eventA,
      eventB,
      preNormA,
      preNormB,
      pair.mlCombinedScore ?? pair.stringScore,
      "match-review",
    );
  } catch (err) {
    logger.warn(
      tag,
      `learnAliases failed for ${pair.id}: ${(err as Error).message}`,
    );
  }
}
