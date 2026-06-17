import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.fn();
const select = vi.fn(() => query);
let joined = false;
const query = {
  from: vi.fn(() => {
    joined = false;
    return query;
  }),
  innerJoin: vi.fn(() => {
    joined = true;
    return query;
  }),
  where: vi.fn(() => (joined ? query : rows())),
  orderBy: vi.fn(() => query),
  limit: vi.fn(async () => rows()),
  then: vi.fn((resolve, reject) => rows().then(resolve, reject)),
};

vi.mock("../../../lib/db/client", () => ({
  db: {
    select,
  },
}));

const {
  filterNewCandidateKeys,
  planCompatibleCanonicalClusterMerge,
  readReliabilityStats,
} = await import("../../../lib/event-matcher/repository");

describe("event matcher repository", () => {
  beforeEach(() => {
    joined = false;
    rows.mockReset();
    select.mockClear();
    query.from.mockClear();
    query.innerJoin.mockClear();
    query.where.mockClear();
    query.orderBy.mockClear();
    query.limit.mockClear();
    query.then.mockClear();
  });

  it("skips unchanged candidate shapes and replays changed shapes", async () => {
    rows.mockResolvedValue([
      { candidateKey: "unchanged", shapeFingerprint: "shape-a" },
      { candidateKey: "changed", shapeFingerprint: "old-shape" },
    ]);

    const keys = await filterNewCandidateKeys([
      { candidateKey: "unchanged", shapeFingerprint: "shape-a" },
      { candidateKey: "changed", shapeFingerprint: "shape-b" },
      { candidateKey: "new", shapeFingerprint: "shape-c" },
    ]);

    expect(keys).toEqual(new Set(["changed", "new"]));
  });

  it("includes existing keys when explicitly replaying selected decisions", async () => {
    const keys = await filterNewCandidateKeys(
      [{ candidateKey: "existing", shapeFingerprint: "shape-a" }],
      { includeExisting: true },
    );

    expect(keys).toEqual(new Set(["existing"]));
    expect(rows).not.toHaveBeenCalled();
  });

  it("marks reliability degraded when DeepSeek conflict rates are high", async () => {
    rows.mockResolvedValue([
      {
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "llm_evidence_conflict",
      },
      {
        decision: "human_review",
        decisionStage: "deepseek",
        reasonCode: "llm_evidence_conflict",
      },
      {
        decision: "human_review",
        decisionStage: "deepseek",
        reasonCode: "llm_evidence_conflict",
      },
      {
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "llm_uncertain",
      },
      {
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "llm_uncertain",
      },
    ]);

    const stats = await readReliabilityStats();

    expect(stats.deepseekReviewed).toBe(5);
    expect(stats.contradictorySourceRate).toBe(0.6);
    expect(stats.healthy).toBe(false);
    expect(stats.degradationReason).toContain("conflicts");
  });

  it("counts grounded-review skips separately from attempted reviews", async () => {
    rows.mockResolvedValue([
      {
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "grounded_review_disabled",
      },
      {
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "grounded_review_degraded",
      },
      {
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "grounded_review_cap_reached",
      },
    ]);

    const stats = await readReliabilityStats();

    expect(stats.deepseekReviewed).toBe(0);
    expect(stats.groundedReviewSkipped).toBe(3);
    expect(stats.groundedReviewDisabled).toBe(1);
    expect(stats.groundedReviewDegraded).toBe(1);
    expect(stats.groundedReviewCapReached).toBe(1);
    expect(stats.humanFallback).toBe(3);
  });

  it("does not degrade grounded review just because canonical clusters conflict", async () => {
    rows.mockResolvedValue(
      Array.from({ length: 5 }, () => ({
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "cluster_conflict",
      })),
    );

    const stats = await readReliabilityStats();

    expect(stats.clusterConflicts).toBe(5);
    expect(stats.deepseekReviewed).toBe(0);
    expect(stats.healthy).toBe(true);
    expect(stats.degradationReason).toBeNull();
  });

  it("plans compatible cluster merges using non-synthetic Saba members only", async () => {
    rows
      .mockResolvedValueOnce([
        {
          id: "canonical-a",
          sport: "football",
          homeTeamCanonical: "Canada",
          awayTeamCanonical: "Bosnia",
          competitionCanonical: "FIFA World Cup",
          kickoff: "2026-06-12T19:00:00.000Z",
          status: "active",
          createdAt: "2026-06-12T00:00:00.000Z",
        },
        {
          id: "canonical-b",
          sport: "football",
          homeTeamCanonical: "Canada 75:01-90:00",
          awayTeamCanonical: "Bosnia-Herzegovina 75:01-90:00",
          competitionCanonical:
            "*WORLD CUP 2026 (IN CANADA, MEXICO & USA) - SPECIFIC 15 MINS",
          kickoff: "2026-06-12T19:00:00.000Z",
          status: "active",
          createdAt: "2026-06-12T00:01:00.000Z",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "member-a",
          canonicalEventId: "canonical-a",
          snapshotId: "snapshot-a",
          provider: "saba-sportsbook",
          providerEventId: "match",
          sport: "football",
          homeTeamRaw: "Canada",
          awayTeamRaw: "Bosnia-Herzegovina",
          competitionRaw: "*WORLD CUP 2026 (IN CANADA, MEXICO & USA)",
          parsedKickoff: "2026-06-12T19:00:00.000Z",
        },
        {
          id: "member-b",
          canonicalEventId: "canonical-b",
          snapshotId: "snapshot-b",
          provider: "pinnacle",
          providerEventId: "match",
          sport: "football",
          homeTeamRaw: "Canada",
          awayTeamRaw: "Bosnia and Herzegovina",
          competitionRaw: "FIFA - World Cup",
          parsedKickoff: "2026-06-12T19:00:00.000Z",
        },
        {
          id: "synthetic",
          canonicalEventId: "canonical-b",
          snapshotId: "snapshot-synthetic",
          provider: "saba-sportsbook",
          providerEventId: "corners",
          sport: "football",
          homeTeamRaw: "Canada No.of Corners 75:01-90:00",
          awayTeamRaw: "Bosnia-Herzegovina No.of Corners 75:01-90:00",
          competitionRaw:
            "*WORLD CUP 2026 (IN CANADA, MEXICO & USA) - SPECIFIC 15 MINS NUMBER OF CORNERS",
          parsedKickoff: "2026-06-12T19:00:00.000Z",
        },
      ]);

    const plan = await planCompatibleCanonicalClusterMerge({
      conflictCanonicalEventIds: ["canonical-a", "canonical-b"],
      score: {
        home: 1,
        away: 1,
        swappedHome: 0.1,
        swappedAway: 0.1,
        sameOrientationTeam: 1,
        swappedOrientationTeam: 0.1,
        bestTeam: 1,
        orientation: "same",
        competition: 1,
        kickoff: 1,
        kickoffExact: true,
        providerReliability: 0.9,
        alias: 1,
        metadata: 0,
        embeddingTeam: 0.99,
        embeddingCompetition: 0.99,
        combined: 0.95,
        diagnostics: {
          exactKickoff: true,
          providerPair: "pinnacle__saba-sportsbook",
          providerHints: [],
        },
      },
    });

    expect(plan).toEqual({
      action: "merge",
      canonicalEventId: "canonical-a",
      sourceCanonicalEventIds: ["canonical-b"],
      reason:
        "Conflicting canonical clusters have compatible teams, sport, kickoff, providers, and score evidence.",
    });
  });

  it("counts no-source and search-failure DeepSeek fallbacks explicitly", async () => {
    rows.mockResolvedValue([
      {
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "llm_no_source",
      },
      {
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "llm_search_failure",
      },
      {
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "llm_uncertain",
      },
    ]);

    const stats = await readReliabilityStats();

    expect(stats.deepseekReviewed).toBe(3);
    expect(stats.noSource).toBe(1);
    expect(stats.searchFailure).toBe(1);
    expect(stats.noSourceRate).toBeCloseTo(0.333, 3);
    expect(stats.searchFailureRate).toBeCloseTo(0.333, 3);
  });

  it("marks reliability degraded when grounded search failures are high", async () => {
    rows.mockResolvedValue(
      Array.from({ length: 5 }, () => ({
        decision: "human_review",
        decisionStage: "human_review",
        reasonCode: "llm_search_failure",
      })),
    );

    const stats = await readReliabilityStats();

    expect(stats.healthy).toBe(false);
    expect(stats.degradationReason).toContain("Search failure");
  });
});
