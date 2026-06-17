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

interface PolicyEvidenceAssessment {
  present: boolean;
  sameEvidence: number;
  differentEvidence: number;
  contradiction: boolean;
  noSource: boolean;
  notes: string[];
  textSupportsSame: boolean;
  textSupportsDifferent: boolean;
}

const SCORE_EPSILON = 1e-9;

function atLeast(value: number, floor: number): boolean {
  return value + SCORE_EPSILON >= floor;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number {
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function stringFragments(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function rawEvidenceAssessment(residual: DeepSeekResidualDecision): unknown {
  return (residual as { evidenceAssessment?: unknown }).evidenceAssessment;
}

function evidenceAssessmentForPolicy(
  residual: DeepSeekResidualDecision,
): PolicyEvidenceAssessment {
  const raw = rawEvidenceAssessment(residual);
  const record = isRecord(raw) ? raw : null;
  const notes =
    typeof raw === "string"
      ? stringFragments(raw)
      : stringFragments(record?.notes);
  const text = notes.join(" ").toLowerCase();
  const noSource =
    record?.noSource === true ||
    /\b(no usable source|no source|without source|missing source|not enough evidence|too thin)\b/.test(
      text,
    );
  const textSupportsDifferent =
    /\b(source|sources|evidence|web|search|confirmed|confirms|support|supports)\b/.test(
      text,
    ) &&
    (/\b(separate|distinct|different)\s+(matches|fixtures|games|events)\b/.test(
      text,
    ) ||
      /\btwo\s+(separate|distinct|different)\s+(matches|fixtures|games|events)\b/.test(
        text,
      ) ||
      /\bdifferent\s+(teams|clubs|opponents|leagues|competitions|tournaments)\b/.test(
        text,
      ) ||
      /\bno overlap\b/.test(text));
  const textSupportsSame =
    /\b(source|sources|evidence|web|search|confirmed|confirms|support|supports)\b/.test(
      text,
    ) &&
    /\b(same fixture|same match|same event|one fixture|one match|identical fixture|same teams|same opponents)\b/.test(
      text,
    );

  return {
    present: raw !== null && raw !== undefined,
    sameEvidence: record ? nonNegativeInteger(record.sameEvidence) : 0,
    differentEvidence: record
      ? nonNegativeInteger(record.differentEvidence)
      : 0,
    contradiction: record?.contradiction === true,
    noSource,
    notes,
    textSupportsSame,
    textSupportsDifferent,
  };
}

function evidenceTextFragments(residual: DeepSeekResidualDecision): string[] {
  return [
    residual.reasoning,
    ...residual.confirmedFacts,
    ...evidenceAssessmentForPolicy(residual).notes,
  ];
}

function hasContradiction(residual: DeepSeekResidualDecision): boolean {
  if (evidenceAssessmentForPolicy(residual).contradiction) return true;
  const haystack = [
    residual.reasoning,
    ...residual.uncertainties,
    ...evidenceAssessmentForPolicy(residual).notes,
    ...(Array.isArray(residual.diagnostics)
      ? residual.diagnostics.map(String)
      : [JSON.stringify(residual.diagnostics ?? "")]),
  ]
    .join(" ")
    .replace(
      /\b(?:does|do|did|is|are|was|were|not|no|without)\s+(?:not\s+)?(?:contradict|conflict|inconsistent|disagree)\w*\b/gi,
      "",
    )
    .toLowerCase();
  return /\b(contradict|conflict|inconsistent|disagree)\w*\b/.test(haystack);
}

function allegesKickoffConflict(residual: DeepSeekResidualDecision): boolean {
  const fragments = [
    residual.reasoning,
    ...residual.confirmedFacts,
    ...residual.uncertainties,
    ...evidenceAssessmentForPolicy(residual).notes,
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

function hasOneExactSlotDifferentClubEvidence(score: ScoreBreakdown): boolean {
  const alignedHome =
    score.orientation === "same" ? score.home : score.swappedHome;
  const alignedAway =
    score.orientation === "same" ? score.away : score.swappedAway;
  const strongerAlignedTeam = Math.max(alignedHome, alignedAway);
  const weakerAlignedTeam = Math.min(alignedHome, alignedAway);
  const teamConsensus = Math.max(score.bestTeam, score.embeddingTeam ?? 0);
  const competitionConsensus = Math.max(
    score.competition,
    score.embeddingCompetition ?? 0,
  );

  return (
    score.kickoffExact &&
    atLeast(strongerAlignedTeam, 0.98) &&
    weakerAlignedTeam <= 0.75 &&
    atLeast(teamConsensus, 0.82) &&
    atLeast(competitionConsensus, 0.8)
  );
}

function hasSeparateFixtureEvidenceText(
  residual: DeepSeekResidualDecision,
): boolean {
  const haystack = evidenceTextFragments(residual).join(" ").toLowerCase();

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
    ) ||
    /\bno overlap\b/.test(haystack);
  const fixturePairingMentions =
    haystack.match(/\b(?:vs\.?|v\.?|versus)\b/g)?.length ?? 0;
  const confirmedFixtureFacts = residual.confirmedFacts.filter(
    (fact) =>
      /\b(?:vs\.?|v\.?|versus)\b/i.test(fact) && !/\bboth\b/i.test(fact),
  ).length;

  return (
    separateFixture &&
    (materialDifference ||
      fixturePairingMentions >= 2 ||
      confirmedFixtureFacts >= 2)
  );
}

function hasMaterialDifferenceEvidenceText(
  residual: DeepSeekResidualDecision,
): boolean {
  const haystack = evidenceTextFragments(residual).join(" ").toLowerCase();

  return (
    /\b(team|teams|club|clubs|opponent|opponents|side|sides)\b[^.]{0,80}\b(differ|different|distinct|separate|unrelated|do not overlap|no overlap|mismatch)\b/.test(
      haystack,
    ) ||
    /\b(different|distinct|separate|unrelated|mismatched|completely different|entirely different)\b[^.]{0,80}\b(team|teams|club|clubs|opponent|opponents|side|sides)\b/.test(
      haystack,
    ) ||
    /\b(competition|competitions|league|leagues|tournament|tournaments|country|countries)\b[^.]{0,80}\b(differ|different|distinct|separate|unrelated|mismatch)\b/.test(
      haystack,
    ) ||
    /\b(different|distinct|separate|unrelated|mismatched|completely different|entirely different)\b[^.]{0,80}\b(competition|competitions|league|leagues|tournament|tournaments|country|countries)\b/.test(
      haystack,
    )
  );
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
    atLeast(alignedTeam, 0.8) &&
    atLeast(score.bestTeam, 0.88) &&
    atLeast(teamConsensus, 0.9);
  const strongAliasEmbedding =
    atLeast(alignedTeam, 0.78) &&
    atLeast(score.bestTeam, 0.83) &&
    atLeast(teamConsensus, 0.94);

  return (
    score.kickoffExact &&
    (strongTeamText || strongAliasEmbedding) &&
    atLeast(competitionConsensus, 0.62)
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
    atLeast(score.combined, 0.9) &&
    atLeast(alignedTeam, 0.82) &&
    atLeast(score.bestTeam, 0.9) &&
    atLeast(teamConsensus, 0.9) &&
    atLeast(competitionConsensus, 0.9)
  );
}

function scoreSupportsSourceBackedNoisySame(score: ScoreBreakdown): boolean {
  if (score.orientation !== "same") return false;
  const weakerAlignedTeam = Math.min(score.home, score.away);
  const strongerAlignedTeam = Math.max(score.home, score.away);
  const teamConsensus = Math.max(score.bestTeam, score.embeddingTeam ?? 0);
  const competitionConsensus = Math.max(
    score.competition,
    score.embeddingCompetition ?? 0,
  );

  return (
    score.kickoffExact &&
    atLeast(score.combined, 0.84) &&
    atLeast(strongerAlignedTeam, 0.98) &&
    atLeast(weakerAlignedTeam, 0.45) &&
    atLeast(teamConsensus, 0.9) &&
    atLeast(competitionConsensus, 0.84)
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
  const assessment = evidenceAssessmentForPolicy(residual);
  const diagnostics = residual.diagnostics as
    | {
        searchFailureRate?: number;
        searchFailureCount?: number;
      }
    | undefined;
  if (input.kickoffConflictDespiteExactParse) return "llm_time_zone_uncertain";
  if (input.sourceAliasConflict) return "source_alias_conflict";
  if (input.contradictory) return "llm_evidence_conflict";
  if (!input.hasSources || assessment.noSource) {
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

function sameReviewReasonSummary(
  residual: DeepSeekResidualDecision,
  input: {
    contradictory: boolean;
    hasSources: boolean;
  },
): string {
  const assessment = evidenceAssessmentForPolicy(residual);
  if (!input.hasSources || assessment.noSource) {
    return "DeepSeek returned SAME, but no usable source citations were available.";
  }
  if (input.contradictory) {
    return "DeepSeek returned SAME, but source evidence contains conflicting signals.";
  }
  if (assessment.differentEvidence > 0 || assessment.textSupportsDifferent) {
    return "DeepSeek returned SAME, but structured source evidence also includes DIFFERENT support.";
  }
  if (
    assessment.present &&
    assessment.sameEvidence === 0 &&
    assessment.differentEvidence === 0 &&
    !assessment.textSupportsSame
  ) {
    return "DeepSeek returned SAME with sources, but structured source evidence did not identify a one-way SAME signal.";
  }
  return "DeepSeek returned SAME, but source evidence was not decisive enough for auto-merge.";
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
  const assessment = evidenceAssessmentForPolicy(residual);
  const hasSources =
    residual.sources.length > 0 && assessment.noSource !== true;
  const sourceSupportsSame = assessment.present
    ? assessment.sameEvidence > 0 || assessment.textSupportsSame
    : true;
  const sourceSupportsDifferent = assessment.present
    ? assessment.differentEvidence > 0 || assessment.textSupportsDifferent
    : true;
  const sourceOnlySupportsSame =
    sourceSupportsSame &&
    (!assessment.present ||
      (assessment.differentEvidence === 0 &&
        !assessment.textSupportsDifferent));
  const sourceOnlySupportsDifferent =
    sourceSupportsDifferent &&
    (!assessment.present ||
      (assessment.sameEvidence === 0 && !assessment.textSupportsSame));
  const contradictory = hasContradiction(residual);
  const materialUncertainty = hasMaterialUncertainty(residual);
  const materialTeamMismatch = hasMaterialTeamMismatch(score);
  const separateFixtureEvidence = hasSeparateFixtureEvidenceText(residual);
  const materialDifferenceEvidence =
    separateFixtureEvidence || hasMaterialDifferenceEvidenceText(residual);
  const kickoffConflictDespiteExactParse =
    score.kickoffExact &&
    residual.decision === "DIFFERENT" &&
    allegesKickoffConflict(residual) &&
    !(
      (materialTeamMismatch || separateFixtureEvidence) &&
      (sourceSupportsDifferent || materialDifferenceEvidence)
    );
  const sourceAliasConflict =
    residual.decision === "DIFFERENT" &&
    score.kickoffExact &&
    aliasEvidenceCoversDifferentTeamSlots(residual, score) &&
    aliasesCanExplainTeamMismatch(score);
  const sourceBackedDifferent =
    sourceOnlySupportsDifferent ||
    (residual.decision === "DIFFERENT" &&
      (sourceSupportsDifferent || materialDifferenceEvidence) &&
      materialDifferenceEvidence &&
      (materialTeamMismatch ||
        separateFixtureEvidence ||
        hasOneExactSlotDifferentClubEvidence(score)));
  if (
    residual.decision === "SAME" &&
    config.deepseekAutoMergeEnabled &&
    residual.confidence >= config.deepseekAutoMergeConfidence &&
    hasSources &&
    sourceOnlySupportsSame &&
    !materialUncertainty &&
    !contradictory &&
    (score.orientation !== "swapped" || scoreSupportsGroundedSame(score))
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
      (!assessment.present ||
        (assessment.differentEvidence === 0 &&
          !assessment.textSupportsDifferent)) &&
      !contradictory &&
      !materialUncertainty &&
      scoreSupportsGroundedSame(score);
    const strongConsensusPositiveEvidence =
      config.deepseekAutoMergeEnabled &&
      residual.confidence >= config.deepseekConsensusAutoMergeConfidence - 5 &&
      safePositiveEvidence &&
      !materialUncertainty &&
      scoreStronglySupportsGroundedSame(score);
    const dominantSameEvidence =
      config.deepseekAutoMergeEnabled &&
      residual.confidence >= config.deepseekConsensusAutoMergeConfidence - 5 &&
      hasSources &&
      assessment.present &&
      assessment.sameEvidence >= 3 &&
      assessment.differentEvidence <= 1 &&
      !assessment.textSupportsDifferent &&
      !assessment.contradiction &&
      !contradictory &&
      !materialUncertainty &&
      scoreStronglySupportsGroundedSame(score);
    const strongScoreSourceBackedSame =
      config.deepseekAutoMergeEnabled &&
      residual.confidence >= 70 &&
      safePositiveEvidence &&
      !materialUncertainty &&
      scoreStronglySupportsGroundedSame(score);
    const sourceBackedNoisySame =
      config.deepseekAutoMergeEnabled &&
      residual.confidence >= config.deepseekConsensusAutoMergeConfidence - 5 &&
      safePositiveEvidence &&
      !materialUncertainty &&
      scoreSupportsSourceBackedNoisySame(score);
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
    if (dominantSameEvidence) {
      const confidence = Math.max(normalizedConfidence, score.combined);
      return {
        decision: "auto_merge",
        stage: "deepseek",
        confidence,
        confidenceBand: confidenceBand(confidence),
        final: true,
        reasonCode: "grounded_llm_same_match",
        reasonSummary: residual.reasoning,
        groundedDecision: residual.decision,
        groundedConfidence: normalizedConfidence,
      };
    }
    if (strongScoreSourceBackedSame) {
      const confidence = Math.max(normalizedConfidence, score.combined);
      return {
        decision: "auto_merge",
        stage: "deepseek",
        confidence,
        confidenceBand: confidenceBand(confidence),
        final: true,
        reasonCode: "grounded_llm_same_match",
        reasonSummary: residual.reasoning,
        groundedDecision: residual.decision,
        groundedConfidence: normalizedConfidence,
      };
    }
    if (sourceBackedNoisySame) {
      const confidence = Math.max(normalizedConfidence, score.combined);
      return {
        decision: "auto_merge",
        stage: "deepseek",
        confidence,
        confidenceBand: confidenceBand(confidence),
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
      reasonCode: reasonCodeForUnresolvedResidual(residual, {
        kickoffConflictDespiteExactParse: false,
        sourceAliasConflict: false,
        contradictory,
        hasSources,
      }),
      reasonSummary: safePositiveEvidence
        ? residual.reasoning
        : sameReviewReasonSummary(residual, {
            contradictory,
            hasSources,
          }),
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
