
import type { NormalizedEvent } from "../../types";
import type { PreNormalizedNames } from "../normalize";
import { resolveCompetitionSurface } from "./resolver";
import {
  ensureCompetitionEntity,
  ensureTeamEntity,
  recordObservation,
} from "./observations";
import type { ObservationSource } from "../../db/repositories/entities";
import { logger } from "../../shared/logger";

const tag = "MatchHarvester";

export async function harvestMatchPair(
  eventA: NormalizedEvent,
  eventB: NormalizedEvent,
  preNormA: PreNormalizedNames,
  preNormB: PreNormalizedNames,
  matchScore: number,
  source: ObservationSource = "harvester",
): Promise<void> {
  try {
    const providerA =
      (Object.keys(eventA.providers)[0] as string | undefined) ?? "unknown";
    const providerB =
      (Object.keys(eventB.providers)[0] as string | undefined) ?? "unknown";

    const canonical = eventA.providers.pinnacle
      ? eventA
      : eventB.providers.pinnacle
        ? eventB
        : eventA.homeTeam.length >= eventB.homeTeam.length
          ? eventA
          : eventB;
    const variant = canonical === eventA ? eventB : eventA;
    const variantProvider = canonical === eventA ? providerB : providerA;
    const variantPreNorm = canonical === eventA ? preNormB : preNormA;

    const compEntity = await ensureCompetitionEntity(canonical.competition);
    const competitionId = compEntity?.id ?? null;

    const homeEntity = await ensureTeamEntity({
      canonicalName: canonical.homeTeam,
      competitionId,
    });
    const awayEntity = await ensureTeamEntity({
      canonicalName: canonical.awayTeam,
      competitionId,
    });

    const sideA = preNormA;
    const sideB = preNormB;
    const normalScore =
      diceLite(sideA.home, sideB.home) + diceLite(sideA.away, sideB.away);
    const swappedScore =
      diceLite(sideA.home, sideB.away) + diceLite(sideA.away, sideB.home);
    const isSwapped = swappedScore > normalScore;

    const variantHome = isSwapped ? variantPreNorm.away : variantPreNorm.home;
    const variantAway = isSwapped ? variantPreNorm.home : variantPreNorm.away;
    const variantHomeRaw = isSwapped ? variant.awayTeam : variant.homeTeam;
    const variantAwayRaw = isSwapped ? variant.homeTeam : variant.awayTeam;

    if (homeEntity && variantHome !== sideA.home) {
      await recordObservation({
        kind: "team",
        surface: variantHomeRaw,
        provider: variantProvider,
        competitionId,
        pairedWithEntityId: homeEntity.id,
        matchScore,
        outcome: "matched",
        source,
      });
    }
    if (awayEntity && variantAway !== sideA.away) {
      await recordObservation({
        kind: "team",
        surface: variantAwayRaw,
        provider: variantProvider,
        competitionId,
        pairedWithEntityId: awayEntity.id,
        matchScore,
        outcome: "matched",
        source,
      });
    }

    const canonicalProvider = canonical === eventA ? providerA : providerB;
    if (homeEntity) {
      await recordObservation({
        kind: "team",
        surface: canonical.homeTeam,
        provider: canonicalProvider,
        competitionId,
        pairedWithEntityId: homeEntity.id,
        matchScore,
        outcome: "matched",
        source,
      });
    }
    if (awayEntity) {
      await recordObservation({
        kind: "team",
        surface: canonical.awayTeam,
        provider: canonicalProvider,
        competitionId,
        pairedWithEntityId: awayEntity.id,
        matchScore,
        outcome: "matched",
        source,
      });
    }

    if (variant.competition !== canonical.competition && compEntity) {
      await recordObservation({
        kind: "competition",
        surface: variant.competition,
        provider: variantProvider,
        competitionId: null,
        pairedWithEntityId: compEntity.id,
        matchScore,
        outcome: "matched",
        source,
      });
    }
  } catch (err) {
    logger.warn(tag, `harvestMatchPair failed: ${(err as Error).message}`);
  }
}

function diceLite(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size || 1);
}

export { resolveCompetitionSurface };
