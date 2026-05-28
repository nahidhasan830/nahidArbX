import { describe, expect, it, vi } from "vitest";
import type { MatchPairRow } from "@/lib/db/schema";
import {
  resolveMatcherRunWithAiSearch,
  type MatcherAiResolverDeps,
} from "@/lib/matching/matcher-lab-ai-resolver";

function makePair(id: string, stage = "human_review"): MatchPairRow {
  return {
    id,
    stage,
    eventAProvider: "pinnacle",
    eventAHomeTeam: "Arsenal",
    eventAAwayTeam: "Chelsea",
    eventACompetition: "Premier League",
    eventAStartTime: "2026-05-16T15:00:00Z",
    eventAEventId: `a-${id}`,
    eventBProvider: "ninewickets-sportsbook",
    eventBHomeTeam: "Arsenal",
    eventBAwayTeam: "Chelsea",
    eventBCompetition: "Premier League",
    eventBStartTime: "2026-05-16T15:00:00Z",
    eventBEventId: `b-${id}`,
    stringScore: 0.8,
    stringBreakdown: null,
    mlHomeCosine: 0.8,
    mlAwayCosine: 0.8,
    mlCompCosine: 0.8,
    mlCombinedScore: 0.8,
    mlScoredAt: "2026-05-16T15:01:00Z",
    mlModelVersion: "test",
    xeScore: null,
    xePvalue: null,
    xeScoredAt: null,
    decision: null,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    resolutionSource: null,
    pairKey: `key-${id}`,
    detectedAt: "2026-05-16T15:00:00Z",
    stageChangedAt: "2026-05-16T15:01:00Z",
    source: "near-match",
  } as MatchPairRow;
}

function makeDeps(
  overrides: Partial<MatcherAiResolverDeps> = {},
): MatcherAiResolverDeps {
  return {
    loadConfig: vi.fn().mockResolvedValue({
      enabled: true,
      confidenceThreshold: 70,
      maxBatchSize: 20,
    }),
    loadPairs: vi.fn().mockResolvedValue([]),
    matchBatch: vi.fn().mockResolvedValue({
      verdicts: [],
      sources: [],
      searchQueriesUsed: [],
      model: "deepseek-v4-flash",
    }),
    markDecision: vi.fn().mockResolvedValue(true),
    updateRunStats: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("resolveMatcherRunWithAiSearch", () => {
  it("auto-applies high-confidence SAME and DIFFERENT verdicts", async () => {
    const pairs = [makePair("p1"), makePair("p2")];
    const deps = makeDeps({
      loadPairs: vi.fn().mockResolvedValue(pairs),
      matchBatch: vi.fn().mockResolvedValue({
        verdicts: [
          {
            pair_index: 0,
            decision: "SAME",
            confidence: 92,
            reasoning: "Same kickoff and teams.",
          },
          {
            pair_index: 1,
            decision: "DIFFERENT",
            confidence: 88,
            reasoning: "Different teams.",
          },
        ],
        sources: [],
        searchQueriesUsed: [],
        model: "deepseek-v4-flash",
      }),
    });

    const result = await resolveMatcherRunWithAiSearch(
      {
        status: "success",
        processed: 2,
        merged: 0,
        rejected: 0,
        escalated: 2,
        runId: "run-1",
        escalatedPairIds: ["p1", "p2"],
      },
      deps,
    );

    expect(result.merged).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.aiSearchAttempted).toBe(2);
    expect(result.aiSearchMerged).toBe(1);
    expect(result.aiSearchRejected).toBe(1);
    expect(deps.markDecision).toHaveBeenNthCalledWith(
      1,
      pairs[0],
      "ai-merge",
      expect.stringContaining("SAME 92%"),
    );
    expect(deps.markDecision).toHaveBeenNthCalledWith(
      2,
      pairs[1],
      "ai-reject",
      expect.stringContaining("DIFFERENT 88%"),
    );
    expect(deps.updateRunStats).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ attempted: 2, merged: 1, rejected: 1 }),
    );
  });

  it("leaves low-confidence and uncertain verdicts in human review", async () => {
    const deps = makeDeps({
      loadPairs: vi.fn().mockResolvedValue([makePair("p1"), makePair("p2")]),
      matchBatch: vi.fn().mockResolvedValue({
        verdicts: [
          {
            pair_index: 0,
            decision: "SAME",
            confidence: 69,
            reasoning: "Not strong enough.",
          },
          {
            pair_index: 1,
            decision: "UNCERTAIN",
            confidence: 95,
            reasoning: "Evidence conflicts.",
          },
        ],
        sources: [],
        searchQueriesUsed: [],
        model: "deepseek-v4-flash",
      }),
    });

    const result = await resolveMatcherRunWithAiSearch(
      {
        status: "success",
        processed: 2,
        merged: 0,
        rejected: 0,
        escalated: 2,
        runId: "run-1",
        escalatedPairIds: ["p1", "p2"],
      },
      deps,
    );

    expect(result.merged).toBe(0);
    expect(result.rejected).toBe(0);
    expect(result.escalated).toBe(2);
    expect(result.aiSearchAttempted).toBe(2);
    expect(deps.markDecision).not.toHaveBeenCalled();
  });

  it("skips AI Search when escalation is disabled", async () => {
    const deps = makeDeps({
      loadConfig: vi.fn().mockResolvedValue({
        enabled: false,
        confidenceThreshold: 70,
        maxBatchSize: 20,
      }),
    });

    const result = await resolveMatcherRunWithAiSearch(
      {
        status: "success",
        processed: 1,
        merged: 0,
        rejected: 0,
        escalated: 1,
        runId: "run-1",
        escalatedPairIds: ["p1"],
      },
      deps,
    );

    expect(result.escalated).toBe(1);
    expect(result.aiSearchAttempted).toBe(0);
    expect(deps.matchBatch).not.toHaveBeenCalled();
    expect(deps.updateRunStats).not.toHaveBeenCalled();
  });
});
