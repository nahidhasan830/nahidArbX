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

  const weakerAlignedTeam =
    score.orientation === "same"
      ? Math.min(score.home, score.away)
      : Math.min(score.swappedHome, score.swappedAway);
  const hasMatchMetadataRescue = score.metadata > 0;
  const competitionConsensus = Math.max(
    score.competition,
    score.embeddingCompetition ?? 0,
  );
  const weakSwappedTeamSlots =
    score.orientation === "swapped" &&
    weakerAlignedTeam <= config.teamAutoRejectCeiling &&
    score.bestTeam <= config.teamAutoRejectCeiling + 0.07 &&
    !hasMatchMetadataRescue;

  if (score.orientation === "swapped") {
    if (weakSwappedTeamSlots) {
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

    const teamConsensus = Math.max(score.bestTeam, score.embeddingTeam ?? 0);
    if (
      config.deepseekEnabled &&
      (score.combined >= config.residualLow ||
        hasMatchMetadataRescue ||
        teamConsensus >= config.teamAutoMergeFloor)
    ) {
      return {
        decision: "human_review",
        stage: "deepseek",
        confidence: score.combined,
        confidenceBand: confidenceBand(score.combined),
        final: false,
        reasonCode: "swapped_orientation_needs_grounding",
        reasonSummary:
          "Provider team slots are swapped; exact-kickoff candidate needs grounded review before any merge or reject decision.",
      };
    }

    return {
      decision: "human_review",
      stage: "human_review",
      confidence: score.combined,
      confidenceBand: confidenceBand(score.combined),
      final: false,
      reasonCode: "swapped_orientation_needs_review",
      reasonSummary:
        "Provider team slots are swapped and deterministic signals were not strong enough for grounded auto-resolution.",
    };
  }

  const teamPassesMerge =
    score.bestTeam >= config.teamAutoMergeFloor &&
    weakerAlignedTeam >= config.teamAutoMergeFloor;
  const exactAlignedTeams =
    score.orientation === "same" &&
    score.home >= 0.98 &&
    score.away >= 0.98 &&
    score.sameOrientationTeam >= 0.98 &&
    score.bestTeam >= 0.98;
  const compPassesMerge =
    score.competition >= config.competitionAutoMergeFloor ||
    (score.embeddingCompetition ?? 0) >= config.competitionAutoMergeFloor;
  if (exactAlignedTeams && competitionConsensus >= 0.5) {
    const confidence = Math.max(score.combined, 0.9);
    return {
      decision: "auto_merge",
      stage:
        score.embeddingTeam !== null || score.embeddingCompetition !== null
          ? "embedding"
          : "deterministic",
      confidence,
      confidenceBand: confidenceBand(confidence),
      final: true,
      reasonCode: "exact_team_kickoff_match",
      reasonSummary:
        "Both team slots and kickoff match exactly; competition text is plausible and no hard blockers are present.",
    };
  }

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
      reasonCode: "high_confidence_text_match",
      reasonSummary:
        "No hard blockers and team, competition, and provider signals align at the exact kickoff.",
    };
  }

  const weakBothTeamSlots =
    weakerAlignedTeam <= config.teamAutoRejectCeiling &&
    score.bestTeam <= config.teamAutoRejectCeiling + 0.07;
  if (
    score.combined <= config.combinedAutoRejectThreshold ||
    (weakBothTeamSlots && !hasMatchMetadataRescue) ||
    weakSwappedTeamSlots ||
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

  if (
    config.deepseekEnabled &&
    (score.combined >= config.residualLow || hasMatchMetadataRescue)
  ) {
    const reasonCode =
      score.metadata > 0
        ? "alias_or_metadata_needs_grounding"
        : score.competition < config.competitionAutoMergeFloor
          ? "weak_competition_needs_grounding"
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
