import type {
  EventMatcherConfig,
  EventMatcherPolicyDecision,
  ScoreBreakdown,
} from "./types";

export function confidenceBand(confidence: number): string {
  if (confidence >= 0.94) return "very_high";
  if (confidence >= 0.86) return "high";
  if (confidence >= 0.72) return "medium";
  if (confidence >= 0.5) return "low";
  return "very_low";
}

export function decideCandidate(
  hardBlockers: string[],
  score: ScoreBreakdown,
  config: EventMatcherConfig,
): EventMatcherPolicyDecision {
  if (!score.kickoffExact) {
    return {
      decision: "auto_reject",
      stage: "hard_block",
      confidence: 1,
      confidenceBand: "very_high",
      final: true,
      reasonCode: "kickoff_mismatch",
      reasonSummary:
        "Rejected because parsed kickoff timestamps are not exactly equal.",
    };
  }

  if (hardBlockers.length > 0) {
    return {
      decision: "auto_reject",
      stage: "hard_block",
      confidence: 1,
      confidenceBand: "very_high",
      final: true,
      reasonCode: hardBlockers[0],
      reasonSummary: `Rejected by hard blocker: ${hardBlockers.join(", ")}`,
    };
  }

  const teamPassesMerge = score.bestTeam >= config.teamAutoMergeFloor;
  const compPassesMerge =
    score.competition >= config.competitionAutoMergeFloor ||
    (score.embeddingCompetition ?? 0) >= config.competitionAutoMergeFloor;
  if (
    score.combined >= config.combinedAutoMergeThreshold &&
    teamPassesMerge &&
    compPassesMerge
  ) {
    return {
      decision: "auto_merge",
      stage: score.embeddingTeam !== null ? "embedding" : "deterministic",
      confidence: score.combined,
      confidenceBand: confidenceBand(score.combined),
      final: true,
      reasonCode:
        score.orientation === "swapped"
          ? "swapped_orientation_match"
          : "high_confidence_text_match",
      reasonSummary:
        "No hard blockers and team, competition, and provider signals align at the exact kickoff.",
    };
  }

  const hasMatchMetadataRescue = score.metadata > 0;
  const weakerAlignedTeam =
    score.orientation === "same"
      ? Math.min(score.home, score.away)
      : Math.min(score.swappedHome, score.swappedAway);
  const weakBothTeamSlots =
    weakerAlignedTeam <= config.teamAutoRejectCeiling &&
    score.bestTeam <= config.teamAutoRejectCeiling + 0.07;
  if (
    score.combined <= config.combinedAutoRejectThreshold ||
    weakBothTeamSlots ||
    (score.bestTeam <= config.teamAutoRejectCeiling &&
      score.competition <= config.competitionRejectCeiling &&
      !hasMatchMetadataRescue) ||
    (weakerAlignedTeam <= config.teamAutoRejectCeiling &&
      score.competition < config.competitionAutoMergeFloor &&
      !hasMatchMetadataRescue)
  ) {
    const confidence = Math.max(1 - score.combined, 0.75);
    return {
      decision: "auto_reject",
      stage: "deterministic",
      confidence,
      confidenceBand: confidenceBand(confidence),
      final: true,
      reasonCode: "low_team_competition_similarity",
      reasonSummary:
        "Exact kickoff is shared, but team identity signals are too weak and no match-level metadata rescue is present.",
    };
  }

  if (config.deepseekEnabled && score.combined >= config.residualLow) {
    const reasonCode =
      score.metadata > 0
        ? "alias_or_metadata_needs_grounding"
        : score.competition < config.competitionAutoMergeFloor
          ? "weak_competition_needs_grounding"
          : score.orientation === "swapped"
            ? "swapped_orientation_match"
            : score.combined >= config.residualHigh
              ? "merge_gate_uncertain"
              : "residual_uncertain";
    return {
      decision: "human_review",
      stage: "deepseek",
      confidence: score.combined,
      confidenceBand: confidenceBand(score.combined),
      final: false,
      reasonCode,
      reasonSummary:
        score.combined >= config.residualHigh
          ? "Combined confidence is high, but one or more strict merge gates failed."
          : "Exact-kickoff deterministic and metadata signals are plausible but need grounded review.",
    };
  }

  return {
    decision: "human_review",
    stage: "human_review",
    confidence: score.combined,
    confidenceBand: confidenceBand(score.combined),
    final: false,
    reasonCode: "policy_uncertain",
    reasonSummary:
      "Candidate did not satisfy automatic merge or reject thresholds.",
  };
}
