import { matchSingle } from "../matching/ai-search-client";
import { buildMatchQueries } from "../ai/grounding";
import type {
  DeepSeekResidualDecision,
  EventMatcherCandidate,
  EventMatcherConfig,
  EventMatcherPolicyDecision,
  ScoreBreakdown,
} from "./types";
import { confidenceBand } from "./policy";

export async function reviewResidualWithDeepSeek(
  candidate: EventMatcherCandidate,
  score: ScoreBreakdown,
  canonicalMembership: unknown,
): Promise<DeepSeekResidualDecision | null> {
  const a = candidate.snapshotA;
  const b = candidate.snapshotB;
  if (a.parsedKickoff.getTime() !== b.parsedKickoff.getTime()) {
    return null;
  }
  const sharedMatcherContext = {
    candidateKey: candidate.candidateKey,
    scoreBreakdown: score,
    canonicalMembership,
  };
  const verdict = await matchSingle(
    {
      home_team: a.homeTeamRaw,
      away_team: a.awayTeamRaw,
      competition: a.competitionRaw,
      start_time: a.parsedKickoff.toISOString(),
      provider: a.provider,
      normalized: {
        home_team: a.homeTeamNormalized,
        away_team: a.awayTeamNormalized,
        competition: a.competitionNormalized,
      },
      providerMetadata: a.providerMetadata,
      matcherContext: sharedMatcherContext,
    },
    {
      home_team: b.homeTeamRaw,
      away_team: b.awayTeamRaw,
      competition: b.competitionRaw,
      start_time: b.parsedKickoff.toISOString(),
      provider: b.provider,
      normalized: {
        home_team: b.homeTeamNormalized,
        away_team: b.awayTeamNormalized,
        competition: b.competitionNormalized,
      },
      providerMetadata: b.providerMetadata,
      matcherContext: sharedMatcherContext,
    },
  );
  if (!verdict) return null;
  return {
    decision: verdict.decision,
    confidence: verdict.confidence,
    reasoning: verdict.reasoning,
    canonicalEvent: verdict.canonicalEvent,
    confirmedFacts:
      verdict.confirmedFacts.length > 0
        ? verdict.confirmedFacts
        : buildConfirmedFacts(candidate, verdict.decision),
    uncertainties: [
      ...verdict.uncertainties,
      ...buildUncertainties(verdict.decision, verdict.sources.length),
    ],
    evidenceAssessment: verdict.evidenceAssessment,
    aliasEvidence: verdict.aliasEvidence,
    sources: verdict.sources,
    searchQueriesUsed:
      verdict.searchQueriesUsed.length > 0
        ? verdict.searchQueriesUsed
        : buildMatchQueries(
            {
              homeTeam: a.homeTeamRaw,
              awayTeam: a.awayTeamRaw,
              competition: a.competitionRaw,
              startTime: a.parsedKickoff.toISOString(),
              provider: a.provider,
            },
            {
              homeTeam: b.homeTeamRaw,
              awayTeam: b.awayTeamRaw,
              competition: b.competitionRaw,
              startTime: b.parsedKickoff.toISOString(),
              provider: b.provider,
            },
          ),
    model: verdict.model,
    diagnostics: verdict.diagnostics,
  };
}

function buildUncertainties(
  decision: DeepSeekResidualDecision["decision"],
  sourceCount: number,
): string[] {
  const uncertainties: string[] = [];
  if (decision === "UNCERTAIN") {
    uncertainties.push(
      "Grounded evidence did not safely resolve the candidate.",
    );
  }
  if (sourceCount === 0) {
    uncertainties.push("No usable source citations were returned.");
  }
  return uncertainties;
}

function hasContradiction(residual: DeepSeekResidualDecision): boolean {
  if (residual.evidenceAssessment?.contradiction === true) return true;
  const haystack = [
    residual.reasoning,
    ...residual.uncertainties,
    ...(residual.evidenceAssessment?.notes ?? []),
    ...(Array.isArray(residual.diagnostics)
      ? residual.diagnostics.map(String)
      : [JSON.stringify(residual.diagnostics ?? "")]),
  ]
    .join(" ")
    .replace(/\b(?:does|do|did|is|are|was|were|not|no|without)\s+(?:not\s+)?(?:contradict|conflict|inconsistent|disagree)\w*\b/gi, "")
    .toLowerCase();
  return /\b(contradict|conflict|inconsistent|disagree)\w*\b/.test(haystack);
}

function allegesKickoffConflict(residual: DeepSeekResidualDecision): boolean {
  const fragments = [
    residual.reasoning,
    ...residual.confirmedFacts,
    ...residual.uncertainties,
    ...(residual.evidenceAssessment?.notes ?? []),
  ]
    .join(" ")
    .toLowerCase()
    .split(/[.;\n]+/)
    .map((fragment) => fragment.trim())
    .filter(Boolean);

  return fragments.some(
    (fragment) =>
      /\b(kickoff|kick[- ]?off|start time|time)\b/.test(fragment) &&
      /\b(mismatch|difference|differs|apart|conflict\w*|contradict\w*|timezone|time zone)\b/.test(
        fragment,
      ),
  );
}

function hasMaterialUncertainty(residual: DeepSeekResidualDecision): boolean {
  if (residual.uncertainties.length === 0) return false;
  return residual.uncertainties.some((uncertainty) => {
    const text = uncertainty.toLowerCase();
    const harmlessCompetitionNaming =
      /\b(competition|league|tournament)\s+(name|label|naming)\b/.test(text);
    const unresolvedSignal =
      /\b(no source|not found|missing|contradict|conflict|different|uncertain|could not|cannot|ambiguous)\b/.test(
        text,
      );
    return unresolvedSignal && !harmlessCompetitionNaming;
  });
}

function buildConfirmedFacts(
  candidate: EventMatcherCandidate,
  decision: DeepSeekResidualDecision["decision"],
): string[] {
  const facts = [
    `Both provider rows have exact kickoff ${candidate.snapshotA.parsedKickoff.toISOString()}.`,
  ];
  if (decision === "SAME") {
    facts.push("Grounded review identified both rows as the same fixture.");
  } else if (decision === "DIFFERENT") {
    facts.push("Grounded review identified the rows as different fixtures.");
  }
  return facts;
}

function aliasEvidenceCoversDifferentTeamSlots(
  residual: DeepSeekResidualDecision,
  score: ScoreBreakdown,
): boolean {
  const aliasSides = new Set((residual.aliasEvidence ?? []).map((e) => e.side));
  if (aliasSides.size === 0) return false;

  const homeNeedsAlias = score.home < 0.98;
  const awayNeedsAlias = score.away < 0.98;
  const checkedAnyAliasSlot = homeNeedsAlias || awayNeedsAlias;
  if (!checkedAnyAliasSlot) return false;

  return (
    (!homeNeedsAlias || aliasSides.has("home")) &&
    (!awayNeedsAlias || aliasSides.has("away"))
  );
}

function aliasesCanExplainTeamMismatch(score: ScoreBreakdown): boolean {
  const weakerAlignedTeam =
    score.orientation === "same"
      ? Math.min(score.home, score.away)
      : Math.min(score.swappedHome, score.swappedAway);

  return weakerAlignedTeam >= 0.7 && score.bestTeam >= 0.78;
}

function hasMaterialTeamMismatch(score: ScoreBreakdown): boolean {
  const weakerAlignedTeam =
    score.orientation === "same"
      ? Math.min(score.home, score.away)
      : Math.min(score.swappedHome, score.swappedAway);

  return (
    weakerAlignedTeam <= 0.65 ||
    score.bestTeam <= 0.75 ||
    (score.embeddingTeam !== null && score.embeddingTeam <= 0.78)
  );
}

function hasSeparateFixtureEvidenceText(
  residual: DeepSeekResidualDecision,
): boolean {
  const haystack = [
    residual.reasoning,
    ...residual.confirmedFacts,
    ...(residual.evidenceAssessment?.notes ?? []),
  ]
    .join(" ")
    .toLowerCase();

  const separateFixture =
    /\b(separate|distinct|different)\s+(matches|fixtures|games|events)\b/.test(
      haystack,
    ) ||
    /\btwo\s+(separate|distinct|different)\s+(matches|fixtures|games|events)\b/.test(
      haystack,
    );
  const materialDifference =
    /\bdifferent\s+(teams|clubs|opponents|leagues|competitions|tournaments)\b/.test(
      haystack,
    ) ||
    /\bseparate\s+(teams|clubs|opponents|leagues|competitions|tournaments)\b/.test(
      haystack,
    ) ||
    /\b(teams|clubs|opponents|leagues|competitions|tournaments)\s+differ\b/.test(
      haystack,
    );

  return separateFixture && materialDifference;
}

function scoreSupportsGroundedSame(score: ScoreBreakdown): boolean {
  const alignedTeam =
    score.orientation === "same"
      ? Math.min(score.home, score.away)
      : Math.min(score.swappedHome, score.swappedAway);
  const teamConsensus = Math.max(score.bestTeam, score.embeddingTeam ?? 0);
  const competitionConsensus = Math.max(
    score.competition,
    score.embeddingCompetition ?? 0,
  );
  const strongTeamText =
    alignedTeam >= 0.8 && score.bestTeam >= 0.88 && teamConsensus >= 0.9;
  const strongAliasEmbedding =
    alignedTeam >= 0.78 && score.bestTeam >= 0.83 && teamConsensus >= 0.94;

  return (
    score.kickoffExact &&
    (strongTeamText || strongAliasEmbedding) &&
    competitionConsensus >= 0.62
  );
}

function scoreStronglySupportsGroundedSame(score: ScoreBreakdown): boolean {
  const alignedTeam =
    score.orientation === "same"
      ? Math.min(score.home, score.away)
      : Math.min(score.swappedHome, score.swappedAway);
  const teamConsensus = Math.max(score.bestTeam, score.embeddingTeam ?? 0);
  const competitionConsensus = Math.max(
    score.competition,
    score.embeddingCompetition ?? 0,
  );

  return (
    score.kickoffExact &&
    score.combined >= 0.9 &&
    alignedTeam >= 0.82 &&
    score.bestTeam >= 0.9 &&
    teamConsensus >= 0.9 &&
    competitionConsensus >= 0.9
  );
}

function reasonCodeForUnresolvedResidual(
  residual: DeepSeekResidualDecision,
  input: {
    kickoffConflictDespiteExactParse: boolean;
    sourceAliasConflict: boolean;
    contradictory: boolean;
    hasSources: boolean;
  },
): EventMatcherPolicyDecision["reasonCode"] {
  const diagnostics = residual.diagnostics as
    | {
        searchFailureRate?: number;
        searchFailureCount?: number;
      }
    | undefined;
  if (input.kickoffConflictDespiteExactParse) return "llm_time_zone_uncertain";
  if (input.sourceAliasConflict) return "source_alias_conflict";
  if (input.contradictory) return "llm_evidence_conflict";
  if (!input.hasSources || residual.evidenceAssessment?.noSource === true) {
    return "llm_no_source";
  }
  if (
    (diagnostics?.searchFailureRate ?? 0) >= 0.5 ||
    (diagnostics?.searchFailureCount ?? 0) >= 3
  ) {
    return "llm_search_failure";
  }
  return "llm_uncertain";
}

export function policyFromDeepSeek(
  residual: DeepSeekResidualDecision | null,
  hardBlockers: string[],
  score: ScoreBreakdown,
  config: EventMatcherConfig,
): EventMatcherPolicyDecision {
  if (hardBlockers.length > 0) {
    return {
      decision: "auto_reject",
      stage: "hard_block",
      confidence: 1,
      confidenceBand: "very_high",
      final: true,
      reasonCode: hardBlockers[0],
      reasonSummary: `DeepSeek result ignored because hard blockers exist: ${hardBlockers.join(", ")}`,
    };
  }

  if (!residual) {
    return {
      decision: "human_review",
      stage: "human_review",
      confidence: score.combined,
      confidenceBand: confidenceBand(score.combined),
      final: false,
      reasonCode: "deepseek_unavailable",
      reasonSummary: "Search-grounded DeepSeek review failed or timed out.",
    };
  }

  const normalizedConfidence = residual.confidence / 100;
  const assessment = residual.evidenceAssessment;
  const hasSources =
    residual.sources.length > 0 && assessment?.noSource !== true;
  const sourceSupportsSame = assessment ? assessment.sameEvidence > 0 : true;
  const sourceSupportsDifferent = assessment
    ? assessment.differentEvidence > 0
    : true;
  const sourceOnlySupportsSame =
    sourceSupportsSame && (!assessment || assessment.differentEvidence === 0);
  const sourceOnlySupportsDifferent =
    sourceSupportsDifferent && (!assessment || assessment.sameEvidence === 0);
  const contradictory = hasContradiction(residual);
  const materialUncertainty = hasMaterialUncertainty(residual);
  const kickoffConflictDespiteExactParse =
    score.kickoffExact &&
    residual.decision === "DIFFERENT" &&
    allegesKickoffConflict(residual);
  const sourceAliasConflict =
    residual.decision === "DIFFERENT" &&
    score.kickoffExact &&
    aliasEvidenceCoversDifferentTeamSlots(residual, score) &&
    aliasesCanExplainTeamMismatch(score);
  const sourceBackedDifferent =
    sourceOnlySupportsDifferent ||
    (residual.decision === "DIFFERENT" &&
      sourceSupportsDifferent &&
      hasMaterialTeamMismatch(score) &&
      hasSeparateFixtureEvidenceText(residual));
  if (
    residual.decision === "SAME" &&
    config.deepseekAutoMergeEnabled &&
    residual.confidence >= config.deepseekAutoMergeConfidence &&
    hasSources &&
    sourceOnlySupportsSame &&
    !materialUncertainty &&
    !contradictory
  ) {
    return {
      decision: "auto_merge",
      stage: "deepseek",
      confidence: normalizedConfidence,
      confidenceBand: confidenceBand(normalizedConfidence),
      final: true,
      reasonCode: "grounded_llm_same_match",
      reasonSummary: residual.reasoning,
      groundedDecision: residual.decision,
      groundedConfidence: normalizedConfidence,
    };
  }

  if (residual.decision === "SAME") {
    const safePositiveEvidence =
      hasSources && sourceOnlySupportsSame && !contradictory;
    const consensusPositiveEvidence =
      config.deepseekAutoMergeEnabled &&
      residual.confidence >= config.deepseekConsensusAutoMergeConfidence &&
      hasSources &&
      (!assessment || assessment.differentEvidence === 0) &&
      !contradictory &&
      !materialUncertainty &&
      scoreSupportsGroundedSame(score);
    const strongConsensusPositiveEvidence =
      config.deepseekAutoMergeEnabled &&
      residual.confidence >= config.deepseekConsensusAutoMergeConfidence - 5 &&
      safePositiveEvidence &&
      !materialUncertainty &&
      scoreStronglySupportsGroundedSame(score);
    if (consensusPositiveEvidence) {
      return {
        decision: "auto_merge",
        stage: "deepseek",
        confidence: normalizedConfidence,
        confidenceBand: confidenceBand(normalizedConfidence),
        final: true,
        reasonCode: "grounded_llm_same_match",
        reasonSummary: residual.reasoning,
        groundedDecision: residual.decision,
        groundedConfidence: normalizedConfidence,
      };
    }
    if (strongConsensusPositiveEvidence) {
      return {
        decision: "auto_merge",
        stage: "deepseek",
        confidence: normalizedConfidence,
        confidenceBand: confidenceBand(normalizedConfidence),
        final: true,
        reasonCode: "grounded_llm_same_match",
        reasonSummary: residual.reasoning,
        groundedDecision: residual.decision,
        groundedConfidence: normalizedConfidence,
      };
    }

    return {
      decision: "human_review",
      stage: safePositiveEvidence ? "deepseek" : "human_review",
      confidence: normalizedConfidence,
      confidenceBand: confidenceBand(normalizedConfidence),
      final: false,
      reasonCode: safePositiveEvidence
        ? "grounded_llm_same_match"
        : reasonCodeForUnresolvedResidual(residual, {
            kickoffConflictDespiteExactParse: false,
            sourceAliasConflict: false,
            contradictory,
            hasSources,
          }),
      reasonSummary:
        safePositiveEvidence
          ? residual.reasoning
          : "DeepSeek recommended a match without one-way, non-conflicting source evidence.",
      groundedDecision: residual.decision,
      groundedConfidence: normalizedConfidence,
    };
  }

  if (
    residual.decision === "DIFFERENT" &&
    residual.confidence >= config.deepseekAutoRejectConfidence &&
    hasSources &&
    sourceBackedDifferent &&
    !contradictory &&
    !kickoffConflictDespiteExactParse &&
    !sourceAliasConflict
  ) {
    return {
      decision: "auto_reject",
      stage: "deepseek",
      confidence: normalizedConfidence,
      confidenceBand: confidenceBand(normalizedConfidence),
      final: true,
      reasonCode: "grounded_llm_different_match",
      reasonSummary: residual.reasoning,
      groundedDecision: residual.decision,
      groundedConfidence: normalizedConfidence,
    };
  }

  return {
    decision: "human_review",
    stage: "human_review",
    confidence: normalizedConfidence,
    confidenceBand: confidenceBand(normalizedConfidence),
    final: false,
    reasonCode: reasonCodeForUnresolvedResidual(residual, {
      kickoffConflictDespiteExactParse,
      sourceAliasConflict,
      contradictory,
      hasSources,
    }),
    reasonSummary: residual.reasoning,
    groundedDecision: residual.decision,
    groundedConfidence: normalizedConfidence,
  };
}
