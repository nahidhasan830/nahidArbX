import { describe, expect, it } from "vitest";
import { DEFAULT_EVENT_MATCHER_CONFIG } from "../../../lib/event-matcher/config";
import { decideCandidate } from "../../../lib/event-matcher/policy";
import type { ScoreBreakdown } from "../../../lib/event-matcher/types";

function score(overrides: Partial<ScoreBreakdown>): ScoreBreakdown {
  return {
    home: 0.9,
    away: 0.9,
    swappedHome: 0.1,
    swappedAway: 0.1,
    sameOrientationTeam: 0.9,
    swappedOrientationTeam: 0.1,
    bestTeam: 0.9,
    orientation: "same",
    competition: 0.75,
    kickoff: 1,
    kickoffExact: true,
    providerReliability: 0.9,
    alias: 0.9,
    metadata: 0,
    embeddingTeam: null,
    embeddingCompetition: null,
    combined: 0.93,
    diagnostics: {
      exactKickoff: true,
      providerPair: "a__b",
      providerHints: [],
    },
    ...overrides,
  };
}

describe("event matcher policy", () => {
  it("rejects hard blockers before scores", () => {
    const decision = decideCandidate(
      ["gender_mismatch"],
      score({ combined: 0.99 }),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );
    expect(decision.decision).toBe("auto_reject");
    expect(decision.stage).toBe("hard_block");
  });

  it("rejects kickoff mismatches even when scores are high", () => {
    const decision = decideCandidate(
      [],
      score({ combined: 0.99, kickoff: 0, kickoffExact: false }),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );
    expect(decision.decision).toBe("auto_reject");
    expect(decision.stage).toBe("hard_block");
    expect(decision.reasonCode).toBe("kickoff_mismatch");
  });

  it("auto-merges high confidence candidates", () => {
    const decision = decideCandidate(
      [],
      score({ combined: 0.905 }),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );
    expect(decision.decision).toBe("auto_merge");
    expect(decision.reasonCode).toBe("high_confidence_text_match");
  });

  it("auto-merges exact team and kickoff matches even when competition labels are generic", () => {
    const decision = decideCandidate(
      [],
      score({
        home: 1,
        away: 1,
        sameOrientationTeam: 1,
        bestTeam: 1,
        competition: 0.501,
        embeddingTeam: 1,
        embeddingCompetition: 0.739,
        combined: 0.878,
      }),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("auto_merge");
    expect(decision.reasonCode).toBe("exact_team_kickoff_match");
  });

  it("routes strong swapped team slots to grounded review", () => {
    const decision = decideCandidate(
      [],
      score({
        home: 0.42,
        away: 0.47,
        swappedHome: 1,
        swappedAway: 1,
        sameOrientationTeam: 0.445,
        swappedOrientationTeam: 1,
        bestTeam: 1,
        orientation: "swapped",
        competition: 0.95,
        combined: 0.96,
      }),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("human_review");
    expect(decision.stage).toBe("deepseek");
    expect(decision.reasonCode).toBe("swapped_orientation_needs_grounding");
  });

  it("does not auto-merge exact teams when competition agreement is implausible", () => {
    const decision = decideCandidate(
      [],
      score({
        home: 1,
        away: 1,
        sameOrientationTeam: 1,
        bestTeam: 1,
        competition: 0.42,
        embeddingTeam: 1,
        embeddingCompetition: 0.49,
        combined: 0.878,
      }),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("human_review");
    expect(decision.stage).toBe("deepseek");
  });

  it("does not auto-merge when one aligned team slot is below the merge floor", () => {
    const decision = decideCandidate(
      [],
      score({
        home: 0.84,
        away: 1,
        sameOrientationTeam: 0.92,
        bestTeam: 0.92,
        competition: 1,
        combined: 0.91,
      }),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("human_review");
    expect(decision.stage).toBe("deepseek");
  });

  it("routes weak teams with shared match metadata to DeepSeek instead of auto-rejecting", () => {
    const decision = decideCandidate(
      [],
      score({
        home: 0.51,
        away: 0.57,
        sameOrientationTeam: 0.54,
        bestTeam: 0.54,
        competition: 1,
        alias: 0.57,
        metadata: 1,
        combined: 0.7,
      }),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("human_review");
    expect(decision.stage).toBe("deepseek");
    expect(decision.reasonCode).toBe("alias_or_metadata_needs_grounding");
  });

  it("keeps sub-90 confidence candidates in the residual lane", () => {
    const decision = decideCandidate(
      [],
      score({ combined: 0.899 }),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );
    expect(decision.decision).toBe("human_review");
    expect(decision.stage).toBe("deepseek");
  });

  it("routes residual uncertainty to DeepSeek", () => {
    const decision = decideCandidate(
      [],
      score({ combined: 0.8, bestTeam: 0.8, competition: 0.55 }),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );
    expect(decision.stage).toBe("deepseek");
    expect(decision.final).toBe(false);
  });

  it("routes exact-kickoff near-threshold residuals to DeepSeek", () => {
    const decision = decideCandidate(
      [],
      score({
        combined: 0.69,
        bestTeam: 0.69,
        home: 0.79,
        away: 0.59,
        sameOrientationTeam: 0.69,
        competition: 0.59,
      }),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.stage).toBe("deepseek");
    expect(decision.reasonCode).toBe("weak_competition_needs_grounding");
  });

  it("routes weak swapped team identity with generic competition overlap to DeepSeek", () => {
    const decision = decideCandidate(
      [],
      score({
        home: 0.39,
        away: 0.59,
        swappedHome: 0.52,
        swappedAway: 0.51,
        sameOrientationTeam: 0.49,
        swappedOrientationTeam: 0.52,
        bestTeam: 0.52,
        orientation: "swapped",
        competition: 0.71,
        embeddingTeam: 0.7,
        embeddingCompetition: 0.82,
        combined: 0.704,
      }),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("human_review");
    expect(decision.stage).toBe("deepseek");
    expect(decision.reasonCode).toBe("swapped_orientation_needs_grounding");
  });

  it("routes high-confidence merge-gate failures to DeepSeek", () => {
    const decision = decideCandidate(
      [],
      score({ combined: 0.929, bestTeam: 0.75, competition: 0.85 }),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );
    expect(decision.stage).toBe("deepseek");
    expect(decision.final).toBe(false);
    expect(decision.reasonCode).toBe("merge_gate_uncertain");
  });
});
