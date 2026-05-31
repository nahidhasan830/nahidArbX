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
  rebuildImpactForRun: vi.fn(),
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
