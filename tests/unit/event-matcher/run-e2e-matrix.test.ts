import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderEventSnapshot } from "../../../lib/event-matcher/types";

interface EventText {
  provider?: string;
  sport?: string;
  home: string;
  away: string;
  competition: string;
}

interface PairFixture {
  name: string;
  a: EventText;
  b: EventText;
  expectedCandidate: boolean;
}

const savedCandidates: unknown[] = [];
const savedDecisions: unknown[] = [];
const appliedMerges: unknown[] = [];
let currentSnapshots: ProviderEventSnapshot[] = [];

vi.mock("../../../lib/event-matcher/repository", () => ({
  applyCanonicalMerge: vi.fn(async (input: unknown) => {
    appliedMerges.push(input);
  }),
  filterNewCandidateKeys: vi.fn(
    async (
      candidates: Array<{ candidateKey: string; shapeFingerprint: string }>,
    ) => new Set(candidates.map((candidate) => candidate.candidateKey)),
  ),
  insertCandidate: vi.fn(async (candidate: unknown) => {
    savedCandidates.push(candidate);
    return true;
  }),
  insertDecision: vi.fn(async (input: unknown) => {
    savedDecisions.push(input);
    return { id: `decision-${savedDecisions.length}` };
  }),
  loadRecentSnapshots: vi.fn(async () => currentSnapshots),
  loadSnapshotsForDecisionIds: vi.fn(async () => currentSnapshots),
  planCanonicalMerge: vi.fn(async () => ({
    action: "create",
    canonicalEventId: null,
    conflictCanonicalEventIds: [],
    memberCount: 0,
    providers: [],
  })),
  rebuildImpactForRun: vi.fn(),
  supersedeClusterResolvedHumanReviewDecisions: vi.fn(async () => ({
    superseded: 0,
    currentRunSuperseded: 0,
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
const deepseek = await import("../../../lib/event-matcher/deepseek");
const { runEventMatcher } = await import("../../../lib/event-matcher/run");

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(fc|cf|sc|afc|club)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function snapshot(
  id: string,
  input: EventText,
  kickoff: Date,
  fallbackProvider: string,
): ProviderEventSnapshot {
  return {
    id,
    provider: input.provider ?? fallbackProvider,
    providerEventId: id,
    sport: input.sport ?? "football",
    homeTeamRaw: input.home,
    awayTeamRaw: input.away,
    competitionRaw: input.competition,
    homeTeamNormalized: normalize(input.home),
    awayTeamNormalized: normalize(input.away),
    competitionNormalized: normalize(input.competition),
    rawStartTime: kickoff.toISOString(),
    parsedKickoff: kickoff,
    parseStrategy: "e2e-matrix",
    fetchBatchId: "run-e2e-matrix",
    providerMetadata: null,
    rawPayload: null,
  };
}

function makePair(
  name: string,
  a: EventText,
  b: EventText,
  expectedCandidate = true,
): PairFixture {
  return { name, a, b, expectedCandidate };
}

function buildFixtures(): PairFixture[] {
  const pairs: PairFixture[] = [];

  for (let i = 0; i < 20; i++) {
    pairs.push(
      makePair(
        `auto merge exact pair ${i}`,
        {
          provider: i % 2 === 0 ? "pinnacle" : "ninewickets-sportsbook",
          home: `Atlas ${i}`,
          away: `Riverside ${i}`,
          competition: `Global League ${i}`,
        },
        {
          provider: i % 2 === 0 ? "betconstruct" : "saba-sportsbook",
          home: `Atlas ${i}`,
          away: `Riverside ${i}`,
          competition: `Global League ${i}`,
        },
      ),
    );
  }

  for (let i = 0; i < 4; i++) {
    pairs.push(
      makePair(
        `hard reject women mismatch ${i}`,
        {
          home: `Falcons ${i} Women`,
          away: `Harbor ${i} Women`,
          competition: `Premier Women ${i}`,
        },
        {
          home: `Falcons ${i}`,
          away: `Harbor ${i}`,
          competition: `Premier League ${i}`,
        },
      ),
    );
  }

  for (let i = 0; i < 4; i++) {
    pairs.push(
      makePair(
        `hard reject youth mismatch ${i}`,
        {
          home: `Orion ${i} U21`,
          away: `Metro ${i} U21`,
          competition: `Youth League ${i}`,
        },
        {
          home: `Orion ${i}`,
          away: `Metro ${i}`,
          competition: `Senior League ${i}`,
        },
      ),
    );
  }

  for (let i = 0; i < 4; i++) {
    pairs.push(
      makePair(
        `hard reject sport mismatch ${i}`,
        {
          sport: "football",
          home: `Cobalt ${i}`,
          away: `Summit ${i}`,
          competition: `National Football ${i}`,
        },
        {
          sport: "basketball",
          home: `Cobalt ${i}`,
          away: `Summit ${i}`,
          competition: `National Basketball ${i}`,
        },
      ),
    );
  }

  for (let i = 0; i < 12; i++) {
    pairs.push(
      makePair(
        `deterministic reject one-team false positive ${i}`,
        {
          home: "Manchester United",
          away: "Chelsea",
          competition: "England Premier League",
        },
        {
          home: "Manchester United",
          away: "Al Ahly",
          competition: "Egypt Cup",
        },
      ),
    );
  }

  for (let i = 0; i < 12; i++) {
    pairs.push(
      makePair(
        `human review risky same league ${i}`,
        {
          home: `North United ${i}`,
          away: `Harbor City ${i}`,
          competition: `Shared Premier League ${i}`,
        },
        {
          home: `South United ${i}`,
          away: `Harbor City ${i}`,
          competition: `Shared Premier League ${i}`,
        },
      ),
    );
  }

  for (let i = 0; i < 8; i++) {
    pairs.push(
      makePair(
        `no candidate unrelated same kickoff ${i}`,
        {
          home: `Lagoon ${i}`,
          away: `Forest ${i}`,
          competition: `Island League ${i}`,
        },
        {
          home: `Desert ${i}`,
          away: `Mountain ${i}`,
          competition: `Highland Cup ${i}`,
        },
        false,
      ),
    );
  }

  return pairs;
}

function fixturesToSnapshots(fixtures: PairFixture[]): ProviderEventSnapshot[] {
  const base = Date.parse("2026-06-01T12:00:00Z");
  return fixtures.flatMap((fixture, index) => {
    const kickoff = new Date(base + index * 60_000);
    return [
      snapshot(`a-${index}`, fixture.a, kickoff, "pinnacle"),
      snapshot(`b-${index}`, fixture.b, kickoff, "betconstruct"),
    ];
  });
}

describe("runEventMatcher 50+ scenario orchestration matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("EVENT_MATCHER_EMBEDDING_ENABLED", "false");
    vi.mocked(deepseek.reviewResidualWithDeepSeek).mockResolvedValue(null);
    savedCandidates.length = 0;
    savedDecisions.length = 0;
    appliedMerges.length = 0;
    currentSnapshots = fixturesToSnapshots(buildFixtures());
  });

  it("runs synthetic data through generation, scoring, decisions, progress, and merge application", async () => {
    const fixtures = buildFixtures();
    const progress: Array<{ phase: string; message: string }> = [];

    expect(fixtures.length).toBeGreaterThanOrEqual(50);
    expect(fixtures.filter((fixture) => fixture.expectedCandidate)).toHaveLength(
      56,
    );

    const summary = await runEventMatcher({
      trigger: "test",
      mode: "apply",
      applyMerges: true,
      useDeepSeek: false,
      onProgress: (event) => {
        progress.push({ phase: event.phase, message: event.message });
      },
    });

    expect(summary.status).toBe("completed");
    expect(summary.snapshotCount).toBe(128);
    expect(summary.generatedCandidateCount).toBe(56);
    expect(summary.candidateCount).toBe(56);
    expect(summary.skippedCandidateCount).toBe(0);
    expect(summary.autoMerged).toBe(20);
    expect(summary.autoRejected).toBe(24);
    expect(summary.humanReview).toBe(12);
    expect(summary.deepseekReviewed).toBe(0);

    expect(savedCandidates).toHaveLength(56);
    expect(savedDecisions).toHaveLength(56);
    expect(appliedMerges).toHaveLength(20);
    expect(repository.rebuildImpactForRun).toHaveBeenCalledWith(summary.id);
    expect(deepseek.reviewResidualWithDeepSeek).not.toHaveBeenCalled();

    expect(progress.map((event) => event.phase)).toEqual(
      expect.arrayContaining([
        "initializing",
        "loading_snapshots",
        "generating_candidates",
        "filtering_candidates",
        "scoring_candidates",
        "writing_decision",
        "applying_merge",
        "rebuilding_impact",
        "completed",
      ]),
    );

    const decisions = savedDecisions.map((input) => {
      return (
        input as {
          policy: { decision: string; reasonCode: string };
        }
      ).policy;
    });
    expect(
      decisions.filter((decision) => decision.decision === "auto_merge"),
    ).toHaveLength(20);
    expect(
      decisions.filter((decision) => decision.decision === "auto_reject"),
    ).toHaveLength(24);
    expect(
      decisions.filter((decision) => decision.decision === "human_review"),
    ).toHaveLength(12);
    expect(
      decisions.filter(
        (decision) => decision.reasonCode === "grounded_review_disabled",
      ),
    ).toHaveLength(12);
    expect(savedDecisions.every((input) => !("evidence" in input))).toBe(true);
    expect(savedDecisions.every((input) => !("model" in input))).toBe(true);
  });

  it("uses sourced grounded review verdicts to resolve residual candidates", async () => {
    vi.mocked(deepseek.reviewResidualWithDeepSeek).mockResolvedValue({
      decision: "DIFFERENT",
      confidence: 90,
      reasoning: "Grounded source identifies these as different fixtures.",
      canonicalEvent: null,
      confirmedFacts: ["The source lists different opponents."],
      uncertainties: [],
      evidenceAssessment: null,
      sources: [
        {
          url: "https://example.com/fixture",
          title: "Fixture listing",
          snippet: "Different fixture evidence",
        },
      ],
      searchQueriesUsed: ["North United Harbor City fixture"],
      model: "deepseek-test",
    });

    const summary = await runEventMatcher({
      trigger: "test",
      mode: "apply",
      applyMerges: true,
      useDeepSeek: true,
    });

    expect(summary.status).toBe("completed");
    expect(summary.generatedCandidateCount).toBe(56);
    expect(summary.autoMerged).toBe(20);
    expect(summary.autoRejected).toBe(36);
    expect(summary.humanReview).toBe(0);
    expect(summary.deepseekReviewed).toBe(12);
    expect(deepseek.reviewResidualWithDeepSeek).toHaveBeenCalledTimes(12);

    const groundedRejects = savedDecisions.filter((input) => {
      const decision = (
        input as {
          policy: { decision: string; reasonCode: string };
        }
      );
      return (
        decision.policy.decision === "auto_reject" &&
        decision.policy.reasonCode === "grounded_llm_different_match"
      );
    });
    expect(groundedRejects).toHaveLength(12);
    expect(savedDecisions.every((input) => !("evidence" in input))).toBe(true);
    expect(savedDecisions.every((input) => !("model" in input))).toBe(true);
  });
});
