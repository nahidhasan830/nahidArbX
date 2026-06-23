
import type { NearMatch } from "../diagnostics/types";
import { updateNearMatchStatus, getNearMatchById } from "../diagnostics/store";
import { logger } from "../../shared/logger";
import {
  ensureCompetitionEntity,
  ensureTeamEntity,
  recordObservation,
} from "../entities";

export interface LearnedAliases {
  teamAliases: { source: string; canonical: string }[];
  competitionAliases: { source: string; canonical: string }[];
}

export async function learnFromConfirmedMatch(
  nearMatch: NearMatch,
  userId?: string,
): Promise<LearnedAliases> {
  const learned: LearnedAliases = {
    teamAliases: [],
    competitionAliases: [],
  };
  updateNearMatchStatus(nearMatch.id, "confirmed", userId);

  const pinnacleEvent =
    nearMatch.eventA.provider === "pinnacle"
      ? nearMatch.eventA
      : nearMatch.eventB.provider === "pinnacle"
        ? nearMatch.eventB
        : null;
  const canonicalEvent =
    pinnacleEvent ??
    (nearMatch.eventA.homeTeam.length >= nearMatch.eventB.homeTeam.length
      ? nearMatch.eventA
      : nearMatch.eventB);
  const variantEvent =
    canonicalEvent === nearMatch.eventA ? nearMatch.eventB : nearMatch.eventA;
  const orientation = nearMatch.breakdown.bestOrientation;

  const compEntity = await ensureCompetitionEntity(canonicalEvent.competition);
  const competitionId = compEntity?.id ?? null;

  const homeEntity = await ensureTeamEntity({
    canonicalName: canonicalEvent.homeTeam,
    competitionId,
  });
  const awayEntity = await ensureTeamEntity({
    canonicalName: canonicalEvent.awayTeam,
    competitionId,
  });

  const variantHomeRaw =
    orientation === "normal" ? variantEvent.homeTeam : variantEvent.awayTeam;
  const variantAwayRaw =
    orientation === "normal" ? variantEvent.awayTeam : variantEvent.homeTeam;

  const recordOne = async (
    raw: string,
    entityId: string | null,
    provider: string,
    kind: "team" | "competition",
    compId: string | null,
  ) => {
    if (!entityId) return;
    await recordObservation({
      kind,
      surface: raw,
      provider,
      competitionId: compId,
      pairedWithEntityId: entityId,
      matchScore: nearMatch.breakdown.finalScore ?? null,
      outcome: "manual-confirm",
      source: "learner",
    });
  };

  if (
    homeEntity &&
    variantHomeRaw.toLowerCase() !== canonicalEvent.homeTeam.toLowerCase()
  ) {
    await recordOne(
      variantHomeRaw,
      homeEntity.id,
      variantEvent.provider,
      "team",
      competitionId,
    );
    learned.teamAliases.push({
      source: variantHomeRaw,
      canonical: canonicalEvent.homeTeam,
    });
  }
  if (
    awayEntity &&
    variantAwayRaw.toLowerCase() !== canonicalEvent.awayTeam.toLowerCase()
  ) {
    await recordOne(
      variantAwayRaw,
      awayEntity.id,
      variantEvent.provider,
      "team",
      competitionId,
    );
    learned.teamAliases.push({
      source: variantAwayRaw,
      canonical: canonicalEvent.awayTeam,
    });
  }

  if (
    compEntity &&
    variantEvent.competition.toLowerCase() !==
      canonicalEvent.competition.toLowerCase()
  ) {
    await recordOne(
      variantEvent.competition,
      compEntity.id,
      variantEvent.provider,
      "competition",
      null,
    );
    learned.competitionAliases.push({
      source: variantEvent.competition,
      canonical: canonicalEvent.competition,
    });
  }

  logger.info(
    "Learner",
    `Recorded ${learned.teamAliases.length} team + ${learned.competitionAliases.length} comp observations from confirmed match`,
  );
  return learned;
}

export async function confirmNearMatch(
  nearMatchId: string,
  userId?: string,
): Promise<LearnedAliases | null> {
  const nearMatch = getNearMatchById(nearMatchId);
  if (!nearMatch) {
    logger.warn("Learner", `Near-match not found: ${nearMatchId}`);
    return null;
  }
  if (nearMatch.status !== "pending") {
    logger.warn(
      "Learner",
      `Near-match ${nearMatchId} already ${nearMatch.status}`,
    );
    return null;
  }
  return learnFromConfirmedMatch(nearMatch, userId);
}

export function rejectNearMatch(nearMatchId: string, userId?: string): boolean {
  const result = updateNearMatchStatus(nearMatchId, "rejected", userId);
  return result !== null;
}
