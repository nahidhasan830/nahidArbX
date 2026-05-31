import { bestSim } from "../matching/string-sim";
import { embedBatch } from "../matching/entities/matcher-client";
import { cosineSimilarity } from "../matching/entities/vertex-embeddings-client";
import type {
  EventMatcherCandidate,
  EventMatcherConfig,
  ProviderEventSnapshot,
  ScoreBreakdown,
} from "./types";

const PROVIDER_RELIABILITY: Record<string, number> = {
  pinnacle: 0.96,
  betconstruct: 0.84,
  "ninewickets-sportsbook": 0.8,
  "ninewickets-exchange": 0.78,
  "velki-sportsbook": 0.78,
  "saba-sportsbook": 0.74,
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function kickoffScore(
  a: ProviderEventSnapshot,
  b: ProviderEventSnapshot,
): number {
  return a.parsedKickoff.getTime() === b.parsedKickoff.getTime() ? 1 : 0;
}

function providerReliability(a: string, b: string): number {
  return (
    ((PROVIDER_RELIABILITY[a] ?? 0.72) + (PROVIDER_RELIABILITY[b] ?? 0.72)) / 2
  );
}

function vectorScore(a: number[] | null, b: number[] | null): number | null {
  if (!a || !b) return null;
  return clamp01((cosineSimilarity(a, b) + 1) / 2);
}

function providerPair(a: string, b: string): string {
  return [a, b].sort().join("__");
}

const STRONG_MATCH_METADATA_KEYS = new Set([
  "eventId",
  "event_id",
  "fixtureId",
  "fixture_id",
]);

function metadataHints(
  a: ProviderEventSnapshot,
  b: ProviderEventSnapshot,
): string[] {
  const hints: string[] = [];
  const aMetadata = a.providerMetadata ?? {};
  const bMetadata = b.providerMetadata ?? {};
  const sharedKeys = [
    "leagueId",
    "league_id",
    "competitionId",
    "competition_id",
    "tournamentId",
    "tournament_id",
    "eventId",
    "event_id",
    "fixtureId",
    "fixture_id",
  ];

  for (const key of sharedKeys) {
    const av = aMetadata[key];
    const bv = bMetadata[key];
    if (
      av !== undefined &&
      bv !== undefined &&
      String(av).trim() !== "" &&
      String(av) === String(bv)
    ) {
        const strength = STRONG_MATCH_METADATA_KEYS.has(key)
          ? "match"
          : "competition";
        hints.push(`shared_${strength}_${key}`);
    }
  }

  if (
    providerPair(a.provider, b.provider) ===
    "ninewickets-sportsbook__saba-sportsbook"
  ) {
    hints.push("provider_pair_orientation_can_vary");
  }

  if (
    a.provider === "ninewickets-sportsbook" ||
    b.provider === "ninewickets-sportsbook"
  ) {
    hints.push("provider_pair_abbreviated_team_text");
  }

  return hints;
}

export async function scoreCandidate(
  candidate: EventMatcherCandidate,
  config: EventMatcherConfig,
): Promise<ScoreBreakdown> {
  const a = candidate.snapshotA;
  const b = candidate.snapshotB;
  const home = bestSim(a.homeTeamNormalized, b.homeTeamNormalized);
  const away = bestSim(a.awayTeamNormalized, b.awayTeamNormalized);
  const swappedHome = bestSim(a.homeTeamNormalized, b.awayTeamNormalized);
  const swappedAway = bestSim(a.awayTeamNormalized, b.homeTeamNormalized);
  const sameOrientationTeam = (home + away) / 2;
  const swappedOrientationTeam = (swappedHome + swappedAway) / 2;
  const orientation =
    swappedOrientationTeam > sameOrientationTeam ? "swapped" : "same";
  const bestTeam = Math.max(sameOrientationTeam, swappedOrientationTeam);
  const competition = bestSim(a.competitionNormalized, b.competitionNormalized);
  const kickoff = kickoffScore(a, b);
  const kickoffExact = kickoff === 1;
  const reliability = providerReliability(a.provider, b.provider);
  const alias = Math.max(home, away, swappedHome, swappedAway);
  const hints = metadataHints(a, b);
  const metadata = hints.some((hint) => hint.startsWith("shared_match_"))
    ? 1
    : 0;

  let embeddingTeam: number | null = null;
  let embeddingCompetition: number | null = null;
  if (config.embeddingEnabled) {
    const texts =
      orientation === "same"
        ? [
            a.homeTeamRaw,
            b.homeTeamRaw,
            a.awayTeamRaw,
            b.awayTeamRaw,
            a.competitionRaw,
            b.competitionRaw,
          ]
        : [
            a.homeTeamRaw,
            b.awayTeamRaw,
            a.awayTeamRaw,
            b.homeTeamRaw,
            a.competitionRaw,
            b.competitionRaw,
          ];
    const embeddings = await embedBatch(texts);
    if (embeddings) {
      const h = vectorScore(
        embeddings.get(texts[0]) ?? null,
        embeddings.get(texts[1]) ?? null,
      );
      const aw = vectorScore(
        embeddings.get(texts[2]) ?? null,
        embeddings.get(texts[3]) ?? null,
      );
      if (h !== null && aw !== null) embeddingTeam = (h + aw) / 2;
      embeddingCompetition = vectorScore(
        embeddings.get(texts[4]) ?? null,
        embeddings.get(texts[5]) ?? null,
      );
    }
  }

  const teamForCombined = Math.max(bestTeam, embeddingTeam ?? 0);
  const compForCombined = Math.max(competition, embeddingCompetition ?? 0);
  const combined = clamp01(
    teamForCombined * 0.56 +
      compForCombined * 0.26 +
      reliability * 0.06 +
      alias * 0.08 +
      metadata * 0.04,
  );

  return {
    home,
    away,
    swappedHome,
    swappedAway,
    sameOrientationTeam,
    swappedOrientationTeam,
    bestTeam,
    orientation,
    competition,
    kickoff,
    kickoffExact,
    providerReliability: reliability,
    alias,
    metadata,
    embeddingTeam,
    embeddingCompetition,
    combined,
    diagnostics: {
      exactKickoff: kickoffExact,
      providerPair: providerPair(a.provider, b.provider),
      providerHints: hints,
    },
  };
}
