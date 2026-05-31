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
