import type { EventMatcherConfig } from "./types";

export const DEFAULT_EVENT_MATCHER_CONFIG: EventMatcherConfig = {
  sameProviderBlocked: true,
  scoringVersion: "event-matcher-scoring-v5",
  groundingVersion: "event-matcher-grounding-v4",
  candidateLlmAdmitTeamFloor: 0.74,
  teamAutoMergeFloor: 0.86,
  teamAutoRejectCeiling: 0.55,
  competitionAutoMergeFloor: 0.64,
  competitionRejectCeiling: 0.25,
  combinedAutoMergeThreshold: 0.9,
  combinedAutoRejectThreshold: 0.48,
  residualLow: 0.68,
  residualHigh: 0.9,
  deepseekEnabled: true,
  deepseekAutoMergeEnabled: true,
  deepseekAutoMergeConfidence: 94,
  deepseekConsensusAutoMergeConfidence: 90,
  deepseekAutoRejectConfidence: 86,
  embeddingEnabled: true,
};

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  return fallback;
}

export function getEventMatcherConfig(): EventMatcherConfig {
  return {
    ...DEFAULT_EVENT_MATCHER_CONFIG,
    scoringVersion:
      process.env.EVENT_MATCHER_SCORING_VERSION ||
      DEFAULT_EVENT_MATCHER_CONFIG.scoringVersion,
    groundingVersion:
      process.env.EVENT_MATCHER_GROUNDING_VERSION ||
      DEFAULT_EVENT_MATCHER_CONFIG.groundingVersion,
    combinedAutoMergeThreshold: readNumber(
      "EVENT_MATCHER_AUTO_MERGE_THRESHOLD",
      DEFAULT_EVENT_MATCHER_CONFIG.combinedAutoMergeThreshold,
    ),
    candidateLlmAdmitTeamFloor: readNumber(
      "EVENT_MATCHER_LLM_ADMIT_TEAM_FLOOR",
      DEFAULT_EVENT_MATCHER_CONFIG.candidateLlmAdmitTeamFloor,
    ),
    teamAutoMergeFloor: readNumber(
      "EVENT_MATCHER_TEAM_AUTO_MERGE_FLOOR",
      DEFAULT_EVENT_MATCHER_CONFIG.teamAutoMergeFloor,
    ),
    teamAutoRejectCeiling: readNumber(
      "EVENT_MATCHER_TEAM_AUTO_REJECT_CEILING",
      DEFAULT_EVENT_MATCHER_CONFIG.teamAutoRejectCeiling,
    ),
    competitionAutoMergeFloor: readNumber(
      "EVENT_MATCHER_COMPETITION_AUTO_MERGE_FLOOR",
      DEFAULT_EVENT_MATCHER_CONFIG.competitionAutoMergeFloor,
    ),
    competitionRejectCeiling: readNumber(
      "EVENT_MATCHER_COMPETITION_REJECT_CEILING",
      DEFAULT_EVENT_MATCHER_CONFIG.competitionRejectCeiling,
    ),
    combinedAutoRejectThreshold: readNumber(
      "EVENT_MATCHER_AUTO_REJECT_THRESHOLD",
      DEFAULT_EVENT_MATCHER_CONFIG.combinedAutoRejectThreshold,
    ),
    residualLow: readNumber(
      "EVENT_MATCHER_RESIDUAL_LOW",
      DEFAULT_EVENT_MATCHER_CONFIG.residualLow,
    ),
    residualHigh: readNumber(
      "EVENT_MATCHER_RESIDUAL_HIGH",
      DEFAULT_EVENT_MATCHER_CONFIG.residualHigh,
    ),
    deepseekEnabled: readBoolean(
      "EVENT_MATCHER_DEEPSEEK_ENABLED",
      DEFAULT_EVENT_MATCHER_CONFIG.deepseekEnabled,
    ),
    deepseekAutoMergeEnabled: readBoolean(
      "EVENT_MATCHER_DEEPSEEK_AUTO_MERGE_ENABLED",
      DEFAULT_EVENT_MATCHER_CONFIG.deepseekAutoMergeEnabled,
    ),
    deepseekAutoMergeConfidence: readNumber(
      "EVENT_MATCHER_DEEPSEEK_AUTO_MERGE_CONFIDENCE",
      DEFAULT_EVENT_MATCHER_CONFIG.deepseekAutoMergeConfidence,
    ),
    deepseekConsensusAutoMergeConfidence: readNumber(
      "EVENT_MATCHER_DEEPSEEK_CONSENSUS_AUTO_MERGE_CONFIDENCE",
      DEFAULT_EVENT_MATCHER_CONFIG.deepseekConsensusAutoMergeConfidence,
    ),
    deepseekAutoRejectConfidence: readNumber(
      "EVENT_MATCHER_DEEPSEEK_AUTO_REJECT_CONFIDENCE",
      DEFAULT_EVENT_MATCHER_CONFIG.deepseekAutoRejectConfidence,
    ),
    embeddingEnabled: readBoolean(
      "EVENT_MATCHER_EMBEDDING_ENABLED",
      DEFAULT_EVENT_MATCHER_CONFIG.embeddingEnabled,
    ),
  };
}
