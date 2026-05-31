import { createHash } from "node:crypto";
import { bestSim } from "../matching/string-sim";
import type {
  EventMatcherCandidate,
  EventMatcherConfig,
  ProviderEventSnapshot,
} from "./types";

const TEAM_ANCHOR_SIMILARITY_FLOOR = 0.78;
const COMPETITION_ANCHOR_SIMILARITY_FLOOR = 0.72;
const GENERIC_TEAM_TOKENS = new Set([
  "a",
  "ac",
  "afc",
  "as",
  "athletic",
  "bk",
  "cf",
  "city",
  "club",
  "fc",
  "if",
  "sc",
  "sk",
  "sporting",
  "sv",
  "town",
  "united",
]);
const GENERIC_COMPETITION_TOKENS = new Set([
  "championship",
  "cup",
  "division",
  "first",
  "league",
  "liga",
  "national",
  "northern",
  "premier",
  "pro",
  "regional",
  "serie",
  "super",
]);

interface TextAnchorEvaluation {
  orientation: "same" | "swapped";
  anchorCount: number;
  teamAnchorCount: number;
  hasCompetitionAnchor: boolean;
  bestTeamSimilarity: number;
  competitionSimilarity: number;
  reasons: string[];
}

function minutesBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 60_000;
}

function sameKickoff(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}

function providerPair(a: string, b: string): string {
  return [a, b].sort().join("__");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

function metadataFingerprint(metadata: Record<string, unknown> | null): string {
  if (!metadata) return "";
  const keys = [
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
    "marketId",
    "market_id",
  ];
  const relevant: Record<string, unknown> = {};
  for (const key of keys) {
    if (metadata[key] !== undefined) relevant[key] = metadata[key];
  }
  return stableJson(relevant);
}

export function candidateKeyFor(
  a: ProviderEventSnapshot,
  b: ProviderEventSnapshot,
): string {
  const first = `${a.provider}:${a.providerEventId}:${a.id}`;
  const second = `${b.provider}:${b.providerEventId}:${b.id}`;
  return createHash("sha256")
    .update([first, second].sort().join("|"))
    .digest("hex")
    .slice(0, 32);
}

export function candidateShapeFingerprintFor(
  a: ProviderEventSnapshot,
  b: ProviderEventSnapshot,
  config: EventMatcherConfig,
): string {
  const first = {
    provider: a.provider,
    providerEventId: a.providerEventId,
    kickoff: a.parsedKickoff.toISOString(),
    home: a.homeTeamNormalized,
    away: a.awayTeamNormalized,
    competition: a.competitionNormalized,
    metadata: metadataFingerprint(a.providerMetadata),
  };
  const second = {
    provider: b.provider,
    providerEventId: b.providerEventId,
    kickoff: b.parsedKickoff.toISOString(),
    home: b.homeTeamNormalized,
    away: b.awayTeamNormalized,
    competition: b.competitionNormalized,
    metadata: metadataFingerprint(b.providerMetadata),
  };
  return createHash("sha256")
    .update(
      stableJson({
        providerPair: providerPair(a.provider, b.provider),
        snapshots: [first, second].sort((x, y) =>
          `${x.provider}:${x.providerEventId}`.localeCompare(
            `${y.provider}:${y.providerEventId}`,
          ),
        ),
        scoringVersion: config.scoringVersion,
        groundingVersion: config.groundingVersion,
      }),
    )
    .digest("hex")
    .slice(0, 32);
}

function meaningfulTokens(
  value: string,
  genericTokens: Set<string>,
): Set<string> {
  const tokens = value
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 3 && !/^\d+$/.test(token) && !genericTokens.has(token),
    );
  return new Set(tokens);
}

function hasSharedMeaningfulToken(
  a: string,
  b: string,
  genericTokens: Set<string>,
): boolean {
  const aTokens = meaningfulTokens(a, genericTokens);
  if (aTokens.size === 0) return false;
  for (const token of meaningfulTokens(b, genericTokens)) {
    if (aTokens.has(token)) return true;
  }
  return false;
}

function hasMeaningfulSimilarity(
  a: string,
  b: string,
  genericTokens: Set<string>,
  floor: number,
): boolean {
  return (
    hasSharedMeaningfulToken(a, b, genericTokens) || bestSim(a, b) >= floor
  );
}

function textAnchorEvaluationForCandidate(
  a: ProviderEventSnapshot,
  b: ProviderEventSnapshot,
): TextAnchorEvaluation {
  const homeSimilarity = bestSim(a.homeTeamNormalized, b.homeTeamNormalized);
  const awaySimilarity = bestSim(a.awayTeamNormalized, b.awayTeamNormalized);
  const swappedHomeSimilarity = bestSim(
    a.homeTeamNormalized,
    b.awayTeamNormalized,
  );
  const swappedAwaySimilarity = bestSim(
    a.awayTeamNormalized,
    b.homeTeamNormalized,
  );
  const competitionSimilarity = bestSim(
    a.competitionNormalized,
    b.competitionNormalized,
  );
  const sameHome = hasMeaningfulSimilarity(
    a.homeTeamNormalized,
    b.homeTeamNormalized,
    GENERIC_TEAM_TOKENS,
    TEAM_ANCHOR_SIMILARITY_FLOOR,
  );
  const sameAway = hasMeaningfulSimilarity(
    a.awayTeamNormalized,
    b.awayTeamNormalized,
    GENERIC_TEAM_TOKENS,
    TEAM_ANCHOR_SIMILARITY_FLOOR,
  );
  const swappedHome = hasMeaningfulSimilarity(
    a.homeTeamNormalized,
    b.awayTeamNormalized,
    GENERIC_TEAM_TOKENS,
    TEAM_ANCHOR_SIMILARITY_FLOOR,
  );
  const swappedAway = hasMeaningfulSimilarity(
    a.awayTeamNormalized,
    b.homeTeamNormalized,
    GENERIC_TEAM_TOKENS,
    TEAM_ANCHOR_SIMILARITY_FLOOR,
  );
  const competition = hasMeaningfulSimilarity(
    a.competitionNormalized,
    b.competitionNormalized,
    GENERIC_COMPETITION_TOKENS,
    COMPETITION_ANCHOR_SIMILARITY_FLOOR,
  );

  const sameCount =
    (sameHome ? 1 : 0) + (sameAway ? 1 : 0) + (competition ? 1 : 0);
  const swappedCount =
    (swappedHome ? 1 : 0) + (swappedAway ? 1 : 0) + (competition ? 1 : 0);
  const orientation = swappedCount > sameCount ? "swapped" : "same";
  const home = orientation === "same" ? sameHome : swappedHome;
  const away = orientation === "same" ? sameAway : swappedAway;
  const sameTeamSimilarity = (homeSimilarity + awaySimilarity) / 2;
  const swappedTeamSimilarity =
    (swappedHomeSimilarity + swappedAwaySimilarity) / 2;
  const reasons: string[] = [];

  if (home) {
    reasons.push(
      orientation === "same"
        ? "home_team_text_anchor"
        : "swapped_home_team_text_anchor",
    );
  }
  if (away) {
    reasons.push(
      orientation === "same"
        ? "away_team_text_anchor"
        : "swapped_away_team_text_anchor",
    );
  }
  if (competition) reasons.push("competition_text_anchor");

  return {
    orientation,
    anchorCount: Math.max(sameCount, swappedCount),
    teamAnchorCount: (home ? 1 : 0) + (away ? 1 : 0),
    hasCompetitionAnchor: competition,
    bestTeamSimilarity: Math.max(sameTeamSimilarity, swappedTeamSimilarity),
    competitionSimilarity,
    reasons,
  };
}

export function hardBlockersForCandidate(
  a: ProviderEventSnapshot,
  b: ProviderEventSnapshot,
  config: EventMatcherConfig,
): string[] {
  const blockers: string[] = [];
  if (config.sameProviderBlocked && a.provider === b.provider) {
    blockers.push("same_provider");
  }
  if (a.sport !== b.sport) blockers.push("sport_mismatch");

  if (!sameKickoff(a.parsedKickoff, b.parsedKickoff)) {
    blockers.push("kickoff_mismatch");
  }
  const combinedText = [
    a.homeTeamNormalized,
    a.awayTeamNormalized,
    a.competitionNormalized,
    b.homeTeamNormalized,
    b.awayTeamNormalized,
    b.competitionNormalized,
  ].join(" ");
  const womenSignals = /\b(women|womens|female|w\b)/i;
  const youthSignals =
    /\b(u17|u18|u19|u20|u21|u23|youth|reserve|reserves|ii)\b/i;
  const aWomen = womenSignals.test(
    `${a.homeTeamRaw} ${a.awayTeamRaw} ${a.competitionRaw}`,
  );
  const bWomen = womenSignals.test(
    `${b.homeTeamRaw} ${b.awayTeamRaw} ${b.competitionRaw}`,
  );
  if (aWomen !== bWomen) blockers.push("gender_mismatch");

  const aYouth = youthSignals.test(
    `${a.homeTeamRaw} ${a.awayTeamRaw} ${a.competitionRaw}`,
  );
  const bYouth = youthSignals.test(
    `${b.homeTeamRaw} ${b.awayTeamRaw} ${b.competitionRaw}`,
  );
  if (aYouth !== bYouth || /\biii\b/i.test(combinedText)) {
    blockers.push("youth_or_tier_mismatch");
  }

  return blockers;
}

const MATCH_METADATA_HINT_KEYS = new Set([
  "eventId",
  "event_id",
  "fixtureId",
  "fixture_id",
]);

function metadataHintForCandidate(
  a: ProviderEventSnapshot,
  b: ProviderEventSnapshot,
): string | null {
  const aMetadata = a.providerMetadata ?? {};
  const bMetadata = b.providerMetadata ?? {};
  const metadataKeys = [
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

  for (const key of metadataKeys) {
    const av = aMetadata[key];
    const bv = bMetadata[key];
    if (
      av !== undefined &&
      bv !== undefined &&
      String(av).trim() !== "" &&
      String(av) === String(bv)
    ) {
      const strength = MATCH_METADATA_HINT_KEYS.has(key)
        ? "match"
        : "competition";
      return `metadata_${strength}_hint:${key}`;
    }
  }

  return null;
}

function admissionForCandidate(
  a: ProviderEventSnapshot,
  b: ProviderEventSnapshot,
  anchors: TextAnchorEvaluation,
  config: EventMatcherConfig,
): { admission: EventMatcherCandidate["admission"] | null; reasons: string[] } {
  const reasons: string[] = [];
  const metadataHint = metadataHintForCandidate(a, b);
  if (metadataHint) reasons.push(metadataHint);
  const hasMatchMetadataHint =
    metadataHint?.startsWith("metadata_match_hint:") ?? false;

  if (
    anchors.teamAnchorCount >= 2 ||
    (anchors.teamAnchorCount >= 1 && anchors.hasCompetitionAnchor)
  ) {
    return { admission: "hard_admit", reasons };
  }

  if (
    anchors.teamAnchorCount >= 1 ||
    anchors.bestTeamSimilarity >= config.candidateLlmAdmitTeamFloor ||
    hasMatchMetadataHint
  ) {
    return { admission: "llm_admit", reasons };
  }

  return { admission: null, reasons };
}

export function generateCandidates(
  snapshots: ProviderEventSnapshot[],
  config: EventMatcherConfig,
  runId: string,
  limit?: number,
): EventMatcherCandidate[] {
  const candidates: EventMatcherCandidate[] = [];
  const sorted = [...snapshots].sort(
    (a, b) => a.parsedKickoff.getTime() - b.parsedKickoff.getTime(),
  );

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      const diff = minutesBetween(a.parsedKickoff, b.parsedKickoff);
      if (diff > 0) break;
      if (a.provider === b.provider) continue;

      const blockers = hardBlockersForCandidate(a, b, config);
      if (blockers.includes("kickoff_mismatch")) {
        continue;
      }
      const textAnchors = textAnchorEvaluationForCandidate(a, b);
      const admission = admissionForCandidate(a, b, textAnchors, config);
      if (!admission.admission) {
        continue;
      }
      const key = candidateKeyFor(a, b);
      const shapeFingerprint = candidateShapeFingerprintFor(a, b, config);
      candidates.push({
        id: `${runId}-${key}`,
        runId,
        snapshotA: a,
        snapshotB: b,
        candidateKey: key,
        shapeFingerprint,
        scoringVersion: config.scoringVersion,
        groundingVersion: config.groundingVersion,
        hardBlockers: blockers,
        reasons: [
          `provider_pair:${providerPair(a.provider, b.provider)}`,
          `shape_fingerprint:${shapeFingerprint}`,
          `scoring_version:${config.scoringVersion}`,
          `grounding_version:${config.groundingVersion}`,
          `kickoff_diff_minutes:${Math.round(diff)}`,
          "kickoff_exact:true",
          `candidate_admission:${admission.admission}`,
          `text_anchor_orientation:${textAnchors.orientation}`,
          `text_anchor_count:${textAnchors.anchorCount}`,
          `team_anchor_count:${textAnchors.teamAnchorCount}`,
          `competition_anchor:${textAnchors.hasCompetitionAnchor}`,
          `best_team_similarity:${textAnchors.bestTeamSimilarity.toFixed(3)}`,
          `competition_similarity:${textAnchors.competitionSimilarity.toFixed(3)}`,
          ...textAnchors.reasons,
          ...admission.reasons,
        ],
        admission: admission.admission,
        sourceStage: "candidate_generation",
      });
      if (limit && candidates.length >= limit) return candidates;
    }
  }

  return candidates;
}
