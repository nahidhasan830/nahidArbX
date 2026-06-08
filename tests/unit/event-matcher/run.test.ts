import { beforeEach, describe, expect, it, vi } from "vitest";

const candidates = [
  {
    id: "run-old",
    runId: "run",
    candidateKey: "key-old",
    shapeFingerprint: "shape-old",
    scoringVersion: "scoring",
    groundingVersion: "grounding",
    hardBlockers: [],
    reasons: [],
    admission: "hard_admit",
    sourceStage: "candidate_generation",
    snapshotA: { id: "a" },
    snapshotB: { id: "b" },
  },
  {
    id: "run-new",
    runId: "run",
    candidateKey: "key-new",
    shapeFingerprint: "shape-new",
    scoringVersion: "scoring",
    groundingVersion: "grounding",
    hardBlockers: [],
    reasons: [],
    admission: "hard_admit",
    sourceStage: "candidate_generation",
    snapshotA: { id: "c" },
    snapshotB: { id: "d" },
  },
];

vi.mock("../../../lib/event-matcher/candidates", () => ({
  generateCandidates: vi.fn(() => candidates),
}));

vi.mock("../../../lib/event-matcher/repository", () => ({
  applyCompatibleCanonicalClusterMerge: vi.fn(),
  applyCanonicalMerge: vi.fn(),
  createRun: vi.fn(),
  filterNewCandidateKeys: vi.fn(async () => new Set(["key-new"])),
  finishRun: vi.fn(),
  insertCandidate: vi.fn(async () => true),
  insertDecision: vi.fn(async () => ({ id: "decision" })),
  loadRecentSnapshots: vi.fn(async () => [{ id: "snapshot" }]),
  loadSnapshotsForDecisionIds: vi.fn(async () => [{ id: "snapshot" }]),
  planCanonicalMerge: vi.fn(async () => ({
    action: "create",
    canonicalEventId: null,
    conflictCanonicalEventIds: [],
    memberCount: 0,
    providers: [],
  })),
  planCompatibleCanonicalClusterMerge: vi.fn(async () => ({
    action: "blocked",
    canonicalEventId: null,
    sourceCanonicalEventIds: [],
    reason: "not compatible",
  })),
  rebuildImpactForRun: vi.fn(),
  supersedeClusterResolvedHumanReviewDecisions: vi.fn(async () => ({
    superseded: 0,
    currentRunSuperseded: 0,
  })),
  supersedeStaleHumanReviewDecisions: vi.fn(async () => 0),
}));

vi.mock("../../../lib/event-matcher/scoring", () => ({
  scoreCandidate: vi.fn(async () => ({
    home: 0.95,
    away: 0.95,
    swappedHome: 0.1,
    swappedAway: 0.1,
    sameOrientationTeam: 0.95,
    swappedOrientationTeam: 0.1,
    bestTeam: 0.95,
    orientation: "same",
    competition: 0.8,
    kickoff: 1,
    kickoffExact: true,
    providerReliability: 0.9,
    alias: 0.95,
    metadata: 0,
    embeddingTeam: null,
    embeddingCompetition: null,
    combined: 0.94,
    diagnostics: {
      exactKickoff: true,
      providerPair: "a__b",
      providerHints: [],
    },
  })),
}));

vi.mock("../../../lib/event-matcher/deepseek", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../lib/event-matcher/deepseek")>();
  return {
    ...actual,
    reviewResidualWithDeepSeek: vi.fn(async () => null),
  };
});

const repository = await import("../../../lib/event-matcher/repository");
const scoring = await import("../../../lib/event-matcher/scoring");
const deepseek = await import("../../../lib/event-matcher/deepseek");
const { runEventMatcher } = await import("../../../lib/event-matcher/run");

function residualScore() {
  return {
    home: 0.8,
    away: 0.8,
    swappedHome: 0.1,
    swappedAway: 0.1,
    sameOrientationTeam: 0.8,
    swappedOrientationTeam: 0.1,
    bestTeam: 0.8,
    orientation: "same" as const,
    competition: 0.55,
    kickoff: 1,
    kickoffExact: true,
    providerReliability: 0.9,
    alias: 0.8,
    metadata: 0,
    embeddingTeam: null,
    embeddingCompetition: null,
    combined: 0.8,
    diagnostics: {
      exactKickoff: true,
      providerPair: "a__b",
      providerHints: [],
    },
  };
}

describe("runEventMatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("skips previously scored candidate keys before scoring", async () => {
    const summary = await runEventMatcher({
      trigger: "test",
      mode: "apply",
      useDeepSeek: false,
    });

    expect(repository.filterNewCandidateKeys).toHaveBeenCalledWith(
      [
        { candidateKey: "key-old", shapeFingerprint: "shape-old" },
        { candidateKey: "key-new", shapeFingerprint: "shape-new" },
      ],
      { includeExisting: false },
    );
    expect(scoring.scoreCandidate).toHaveBeenCalledTimes(1);
    expect(scoring.scoreCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ candidateKey: "key-new" }),
      expect.any(Object),
    );
    expect(repository.insertCandidate).toHaveBeenCalledTimes(1);
    expect(summary.generatedCandidateCount).toBe(2);
    expect(summary.candidateCount).toBe(1);
    expect(summary.skippedCandidateCount).toBe(1);
  });

  it("supersedes selected stale review rows that no longer generate candidates", async () => {
    vi.mocked(repository.supersedeStaleHumanReviewDecisions).mockResolvedValueOnce(
      2,
    );

    const summary = await runEventMatcher({
      trigger: "test",
      mode: "apply",
      useDeepSeek: false,
      decisionIds: ["decision-a", "decision-b"],
    });

    expect(repository.supersedeStaleHumanReviewDecisions).toHaveBeenCalledWith({
      decisionIds: ["decision-a", "decision-b"],
      runId: summary.id,
      generatedCandidateKeys: new Set(["key-old", "key-new"]),
    });
    expect(summary.autoRejected).toBe(2);
  });

  it("supersedes review rows already resolved by canonical clusters", async () => {
    vi.mocked(
      repository.supersedeClusterResolvedHumanReviewDecisions,
    ).mockResolvedValueOnce({
      superseded: 2,
      currentRunSuperseded: 0,
    });

    const summary = await runEventMatcher({
      trigger: "test",
      mode: "apply",
      useDeepSeek: false,
    });

    expect(
      repository.supersedeClusterResolvedHumanReviewDecisions,
    ).toHaveBeenCalledWith({ runId: summary.id });
    expect(summary.autoMerged).toBe(3);
    expect(summary.humanReview).toBe(0);
  });

  it("removes same-run review debt when canonical cleanup supersedes it", async () => {
    vi.mocked(scoring.scoreCandidate).mockResolvedValueOnce(residualScore());
    vi.mocked(
      repository.supersedeClusterResolvedHumanReviewDecisions,
    ).mockResolvedValueOnce({
      superseded: 1,
      currentRunSuperseded: 1,
    });

    const summary = await runEventMatcher({
      trigger: "test",
      mode: "apply",
      useDeepSeek: false,
    });

    expect(summary.autoMerged).toBe(1);
    expect(summary.humanReview).toBe(0);
  });

  it("merges compatible canonical clusters instead of leaving review debt", async () => {
    vi.mocked(scoring.scoreCandidate).mockResolvedValueOnce({
      ...residualScore(),
      home: 0.83,
      away: 1,
      sameOrientationTeam: 0.915,
      bestTeam: 0.915,
      competition: 0.99,
      embeddingTeam: 0.94,
      embeddingCompetition: 0.99,
      combined: 0.94,
    });
    vi.mocked(deepseek.reviewResidualWithDeepSeek).mockResolvedValueOnce({
      decision: "SAME",
      confidence: 90,
      reasoning: "Sources confirm the rows are the same fixture.",
      canonicalEvent: null,
      confirmedFacts: [],
      uncertainties: [],
      evidenceAssessment: {
        sameEvidence: 2,
        differentEvidence: 0,
        contradiction: false,
        noSource: false,
        notes: ["Sources support the same fixture."],
      },
      sources: [
        {
          url: "https://example.test/match",
          title: "Fixture source",
          snippet: "Same fixture.",
        },
      ],
      searchQueriesUsed: [],
      model: "test",
    });
    vi.mocked(repository.planCanonicalMerge)
      .mockResolvedValueOnce({
        action: "create",
        canonicalEventId: null,
        conflictCanonicalEventIds: [],
        memberCount: 0,
        providers: [],
      })
      .mockResolvedValueOnce({
        action: "conflict",
        canonicalEventId: null,
        conflictCanonicalEventIds: ["canonical-a", "canonical-b"],
        memberCount: 2,
        providers: ["pinnacle", "velki-sportsbook"],
      });
    vi.mocked(
      repository.planCompatibleCanonicalClusterMerge,
    ).mockResolvedValueOnce({
      action: "merge",
      canonicalEventId: "canonical-a",
      sourceCanonicalEventIds: ["canonical-b"],
      reason: "clusters are compatible",
    });

    const summary = await runEventMatcher({
      trigger: "test",
      mode: "apply",
      applyMerges: true,
      useDeepSeek: true,
    });

    const decisionInput = vi.mocked(repository.insertDecision).mock.calls[0][0];
    expect(decisionInput.policy.decision).toBe("auto_merge");
    expect(decisionInput.policy.reasonCode).toBe(
      "compatible_canonical_clusters_merged",
    );
    expect(decisionInput.policy.confidence).toBe(0.94);
    expect(decisionInput.policy.confidenceBand).toBe("very_high");
    expect(repository.applyCompatibleCanonicalClusterMerge).toHaveBeenCalledWith(
      {
        decision: { id: "decision" },
        plan: {
          action: "merge",
          canonicalEventId: "canonical-a",
          sourceCanonicalEventIds: ["canonical-b"],
          reason: "clusters are compatible",
        },
      },
    );
    expect(repository.applyCanonicalMerge).not.toHaveBeenCalled();
    expect(summary.autoMerged).toBe(1);
    expect(summary.humanReview).toBe(0);
  });

  it("keeps unsafe canonical cluster conflicts in human review", async () => {
    vi.mocked(repository.planCanonicalMerge).mockResolvedValueOnce({
      action: "conflict",
      canonicalEventId: null,
      conflictCanonicalEventIds: ["canonical-a", "canonical-b"],
      memberCount: 2,
      providers: ["pinnacle", "velki-sportsbook"],
    });
    vi.mocked(
      repository.planCompatibleCanonicalClusterMerge,
    ).mockResolvedValueOnce({
      action: "blocked",
      canonicalEventId: null,
      sourceCanonicalEventIds: [],
      reason: "provider collision",
    });

    const summary = await runEventMatcher({
      trigger: "test",
      mode: "apply",
      applyMerges: true,
      useDeepSeek: false,
    });

    const decisionInput = vi.mocked(repository.insertDecision).mock.calls[0][0];
    expect(decisionInput.policy.decision).toBe("human_review");
    expect(decisionInput.policy.reasonCode).toBe("cluster_conflict");
    expect(decisionInput.policy.reasonSummary).toContain("provider collision");
    expect(repository.applyCompatibleCanonicalClusterMerge).not.toHaveBeenCalled();
    expect(repository.applyCanonicalMerge).not.toHaveBeenCalled();
    expect(summary.autoMerged).toBe(0);
    expect(summary.humanReview).toBe(1);
  });

  it("marks routed grounded review as disabled when DeepSeek is off", async () => {
    vi.mocked(scoring.scoreCandidate).mockResolvedValueOnce(residualScore());

    await runEventMatcher({
      trigger: "test",
      mode: "apply",
      useDeepSeek: false,
    });

    const decisionInput = vi.mocked(repository.insertDecision).mock.calls[0][0];
    expect(decisionInput.policy.reasonCode).toBe("grounded_review_disabled");
    expect(decisionInput.policy.decision).toBe("human_review");
    expect(decisionInput).not.toHaveProperty("evidence");
    expect(decisionInput).not.toHaveProperty("model");
    expect(deepseek.reviewResidualWithDeepSeek).not.toHaveBeenCalled();
  });

  it("marks scheduler-degraded grounded review skips explicitly", async () => {
    vi.mocked(scoring.scoreCandidate).mockResolvedValueOnce(residualScore());

    await runEventMatcher({
      trigger: "test",
      mode: "apply",
      useDeepSeek: false,
      groundedReviewSkipReason: "degraded",
      groundedReviewDegradationReason: "Search failure rate is high",
    });

    const decisionInput = vi.mocked(repository.insertDecision).mock.calls[0][0];
    expect(decisionInput.policy.reasonCode).toBe("grounded_review_degraded");
    expect(decisionInput).not.toHaveProperty("evidence");
    expect(decisionInput).not.toHaveProperty("model");
  });

  it("does not cap grounded DeepSeek reviews per run", async () => {
    vi.mocked(scoring.scoreCandidate).mockResolvedValueOnce(residualScore());

    await runEventMatcher({
      trigger: "test",
      mode: "apply",
      useDeepSeek: true,
    });

    const decisionInput = vi.mocked(repository.insertDecision).mock.calls[0][0];
    expect(decisionInput.policy.reasonCode).toBe("deepseek_unavailable");
    expect(decisionInput).not.toHaveProperty("evidence");
    expect(decisionInput).not.toHaveProperty("model");
    expect(deepseek.reviewResidualWithDeepSeek).toHaveBeenCalledTimes(1);
  });
});
