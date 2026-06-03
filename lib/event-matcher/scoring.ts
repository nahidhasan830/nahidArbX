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

function embeddingText(value: string): string | null {
  const text = value.trim();
  return text.length > 0 ? text : null;
}

async function scoreEmbeddingPairs(
  pairs: Array<[string | null, string | null]>,
): Promise<Array<number | null> | null> {
  const texts = [
    ...new Set(
      pairs.flatMap(([a, b]) => (a && b ? [a, b] : [])),
    ),
  ];
  if (texts.length === 0) return null;

  const embeddings = await embedBatch(texts);
  if (!embeddings) return null;

  return pairs.map(([a, b]) =>
    a && b
      ? vectorScore(embeddings.get(a) ?? null, embeddings.get(b) ?? null)
      : null,
  );
}

function providerPair(a: string, b: string): string {
  return [a, b].sort().join("__");
}

function teamNameVariants(value: string): string[] {
  const variants = new Set([value]);
  if (/^man\s+/.test(value)) {
    variants.add(value.replace(/^man\s+/, "manchester "));
  }
  if (/^ny\s+/.test(value)) {
    variants.add(value.replace(/^ny\s+/, "new york "));
  }
  if (/\byouth\b/.test(value)) {
    for (const age of ["u19", "u20", "u21", "u23"]) {
      variants.add(value.replace(/\byouth\b/g, age));
    }
  }
  if (/\sy$/.test(value)) {
    for (const age of ["u19", "u20", "u21", "u23"]) {
      variants.add(value.replace(/\sy$/, ` ${age}`));
    }
  }
  return [...variants];
}

function teamNameSim(a: string, b: string): number {
  let best = 0;
  for (const av of teamNameVariants(a)) {
    for (const bv of teamNameVariants(b)) {
      best = Math.max(best, bestSim(av, bv));
    }
  }
  return best;
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
  const home = teamNameSim(a.homeTeamNormalized, b.homeTeamNormalized);
  const away = teamNameSim(a.awayTeamNormalized, b.awayTeamNormalized);
  const swappedHome = teamNameSim(a.homeTeamNormalized, b.awayTeamNormalized);
  const swappedAway = teamNameSim(a.awayTeamNormalized, b.homeTeamNormalized);
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
    const pairs: Array<[string | null, string | null]> =
      orientation === "same"
        ? [
            [embeddingText(a.homeTeamRaw), embeddingText(b.homeTeamRaw)],
            [embeddingText(a.awayTeamRaw), embeddingText(b.awayTeamRaw)],
            [embeddingText(a.competitionRaw), embeddingText(b.competitionRaw)],
          ]
        : [
            [embeddingText(a.homeTeamRaw), embeddingText(b.awayTeamRaw)],
            [embeddingText(a.awayTeamRaw), embeddingText(b.homeTeamRaw)],
            [embeddingText(a.competitionRaw), embeddingText(b.competitionRaw)],
          ];
    const scores = await scoreEmbeddingPairs(pairs);
    if (scores) {
      const h = scores[0];
      const aw = scores[1];
      if (h !== null && aw !== null) embeddingTeam = (h + aw) / 2;
      embeddingCompetition = scores[2];
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
