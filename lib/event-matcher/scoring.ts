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
  const texts = [...new Set(pairs.flatMap(([a, b]) => (a && b ? [a, b] : [])))];
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

const CLUB_TOKEN_PATTERN =
  /(^|\s)(fc|sc|cf|ac|ad|as|ec|ss|sv|us|aek|vfb|vfl|tsv|bk|if|kv|sk|rc|rcd|psc|dsc|afc|pfc|cfc|fk)(?=$|\s)/g;
const CLUB_SUFFIX_TOKENS = new Set([
  "afc",
  "bk",
  "cfc",
  "fc",
  "fk",
  "if",
  "pfc",
  "sc",
]);
const TEAM_CONTEXT_TOKENS = new Set([
  "female",
  "ladies",
  "kvinner",
  "res",
  "reserve",
  "reserves",
  "u17",
  "u18",
  "u19",
  "u20",
  "u21",
  "u23",
  "w",
  "women",
  "womens",
  "youth",
]);
const TEAM_NON_IDENTITY_TOKENS = new Set([
  ...CLUB_SUFFIX_TOKENS,
  ...TEAM_CONTEXT_TOKENS,
  "ad",
  "ac",
  "as",
  "club",
  "cf",
  "ec",
  "ss",
  "sv",
  "us",
]);
const COMMON_REGIONAL_SUFFIX_TOKENS = new Set([
  "ba",
  "mg",
  "pe",
  "pr",
  "rj",
  "rs",
  "sc",
  "sp",
]);
const CONTEXT_ONLY_TEAM_SIMILARITY_CEILING = 0.55;
const SPELLING_VARIANT_SIMILARITY_FLOOR = 0.82;
const SUBSET_ONLY_TEAM_SIMILARITY_CEILING = 0.65;

function compactClubInitialisms(value: string): string[] {
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return [];
  const suffix = tokens[tokens.length - 1];
  if (!CLUB_SUFFIX_TOKENS.has(suffix)) return [];

  const initials = tokens.map((token) => token[0]).join("");
  const suffixExpanded =
    tokens
      .slice(0, -1)
      .map((token) => token[0])
      .join("") + suffix;
  return [initials, suffixExpanded];
}

function compactTeamInitialism(value: string): string | null {
  const tokens = value
    .split(/\s+/)
    .filter((token) => token && !TEAM_NON_IDENTITY_TOKENS.has(token));
  if (tokens.length < 2 || tokens.length > 5) return null;
  return tokens.map((token) => token[0]).join("");
}

function teamNameVariants(value: string): string[] {
  const variants = new Set<string>();
  const queue: string[] = [];
  const addVariant = (variant: string) => {
    const normalized = variant.replace(/\s+/g, " ").trim();
    if (!normalized || variants.has(normalized)) return;
    variants.add(normalized);
    queue.push(normalized);
  };

  addVariant(value);

  for (let i = 0; i < queue.length; i++) {
    const variant = queue[i];
    const strippedClubTokens = variant
      .replace(CLUB_TOKEN_PATTERN, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (strippedClubTokens !== variant) {
      addVariant(strippedClubTokens);
    }

    const strippedWomenMarker = variant
      .replace(/\b(w|women|womens|female|ladies|kvinner)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (strippedWomenMarker !== variant) {
      addVariant(strippedWomenMarker);
    }

    const strippedReserveMarker = variant
      .replace(/\b(res|reserve|reserves)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (strippedReserveMarker !== variant) {
      addVariant(strippedReserveMarker);
    }

    const strippedRegionalSuffix = variant
      .split(/\s+/)
      .filter(
        (token, index, tokens) =>
          index !== tokens.length - 1 ||
          !COMMON_REGIONAL_SUFFIX_TOKENS.has(token),
      )
      .join(" ")
      .trim();
    if (strippedRegionalSuffix !== variant) {
      addVariant(strippedRegionalSuffix);
    }

    const strippedLeadingCompoundFk = variant
      .replace(/^[a-z]{2,5}fk\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (strippedLeadingCompoundFk !== variant) {
      addVariant(strippedLeadingCompoundFk);
    }

    for (const compact of compactClubInitialisms(variant)) {
      addVariant(compact);
    }
    const teamInitialism = compactTeamInitialism(variant);
    if (teamInitialism) addVariant(teamInitialism);

    if (/^man\s+/.test(variant)) {
      addVariant(variant.replace(/^man\s+/, "manchester "));
    }
    if (/^ny\s+/.test(variant)) {
      addVariant(variant.replace(/^ny\s+/, "new york "));
    }
    if (/\byouth\b/.test(variant)) {
      for (const age of ["u19", "u20", "u21", "u23"]) {
        addVariant(variant.replace(/\byouth\b/g, age));
      }
    }
    if (/\sy$/.test(variant)) {
      for (const age of ["u19", "u20", "u21", "u23"]) {
        addVariant(variant.replace(/\sy$/, ` ${age}`));
      }
    }
  }

  return [...variants];
}

function teamIdentityTokens(value: string): Set<string> {
  return new Set(
    value
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(
        (token) =>
          token.length >= 2 &&
          !/^\d+$/.test(token) &&
          !TEAM_NON_IDENTITY_TOKENS.has(token),
      ),
  );
}

function variantsShareTeamIdentity(
  aVariants: string[],
  bVariants: string[],
): boolean {
  for (const av of aVariants) {
    const aTokens = teamIdentityTokens(av);
    if (aTokens.size === 0) continue;
    for (const bv of bVariants) {
      const bTokens = teamIdentityTokens(bv);
      if (bTokens.size === 0) continue;
      if (av === bv) return true;
      for (const token of aTokens) {
        if (bTokens.has(token)) return true;
      }
    }
  }
  return false;
}

function isKnownTeamNamePrefix(token: string): boolean {
  return /^(al|atl|atletico|borussia|ca|cd|de|deportivo|fk|hapoel|maccabi|olympique|real|sporting|st|saint|san|santa)$/i.test(
    token,
  );
}

function isAmbiguousGeoQualifier(token: string): boolean {
  return /^(central|east|eastern|equatorial|north|northern|south|southern|west|western)$/i.test(
    token,
  );
}

function isOneSidedSubsetOnlyMatch(a: string, b: string): boolean {
  const aTokens = teamIdentityTokens(a);
  const bTokens = teamIdentityTokens(b);
  if (aTokens.size === 0 || bTokens.size === 0) return false;
  if (aTokens.size === bTokens.size) return false;

  const [smaller, larger] =
    aTokens.size < bTokens.size ? [aTokens, bTokens] : [bTokens, aTokens];
  for (const token of smaller) {
    if (!larger.has(token)) return false;
  }

  const extra = [...larger].filter((token) => !smaller.has(token));
  if (extra.every((token) => isKnownTeamNamePrefix(token))) return false;
  return extra.length > 1 || extra.some((token) => isAmbiguousGeoQualifier(token));
}

function hasOneSidedSubsetOnlyVariantMatch(
  aVariants: string[],
  bVariants: string[],
): boolean {
  for (const av of aVariants) {
    for (const bv of bVariants) {
      if (isOneSidedSubsetOnlyMatch(av, bv)) return true;
    }
  }
  return false;
}

function teamNameSim(a: string, b: string): number {
  const aVariants = teamNameVariants(a);
  const bVariants = teamNameVariants(b);
  let best = 0;
  for (const av of aVariants) {
    for (const bv of bVariants) {
      best = Math.max(best, bestSim(av, bv));
    }
  }
  if (hasOneSidedSubsetOnlyVariantMatch(aVariants, bVariants)) {
    return Math.min(best, SUBSET_ONLY_TEAM_SIMILARITY_CEILING);
  }
  if (variantsShareTeamIdentity(aVariants, bVariants)) return best;
  if (
    best >= SPELLING_VARIANT_SIMILARITY_FLOOR &&
    teamIdentityTokens(a).size > 0 &&
    teamIdentityTokens(b).size > 0
  ) {
    return best;
  }
  return Math.min(best, CONTEXT_ONLY_TEAM_SIMILARITY_CEILING);
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
