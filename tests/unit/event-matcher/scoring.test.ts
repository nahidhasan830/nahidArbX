import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EVENT_MATCHER_CONFIG } from "../../../lib/event-matcher/config";
import { scoreCandidate } from "../../../lib/event-matcher/scoring";
import type {
  EventMatcherCandidate,
  ProviderEventSnapshot,
} from "../../../lib/event-matcher/types";

const embedBatch = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/matching/entities/matcher-client", () => ({
  embedBatch,
}));

vi.mock("../../../lib/matching/entities/vertex-embeddings-client", () => ({
  cosineSimilarity: vi.fn((a: number[], b: number[]) =>
    a[0] === b[0] ? 1 : 0,
  ),
}));

function snapshot(
  id: string,
  overrides: Partial<ProviderEventSnapshot>,
): ProviderEventSnapshot {
  return {
    id,
    provider: `provider-${id}`,
    providerEventId: id,
    sport: "football",
    homeTeamRaw: "Home",
    awayTeamRaw: "Away",
    competitionRaw: "League",
    homeTeamNormalized: "home",
    awayTeamNormalized: "away",
    competitionNormalized: "league",
    rawStartTime: "2026-01-01T10:00:00.000Z",
    parsedKickoff: new Date("2026-01-01T10:00:00.000Z"),
    parseStrategy: "test",
    fetchBatchId: "batch",
    providerMetadata: null,
    rawPayload: null,
    ...overrides,
  };
}

function candidate(
  snapshotA: ProviderEventSnapshot,
  snapshotB: ProviderEventSnapshot,
): EventMatcherCandidate {
  return {
    id: "candidate",
    runId: "run",
    snapshotA,
    snapshotB,
    candidateKey: "key",
    shapeFingerprint: "shape",
    scoringVersion: "scoring",
    groundingVersion: "grounding",
    hardBlockers: [],
    reasons: [],
    admission: "hard_admit",
    sourceStage: "candidate_generation",
  };
}

describe("event matcher scoring", () => {
  it("skips blank embedding pairs without dropping valid team embeddings", async () => {
    const a = snapshot("a", {
      homeTeamRaw: " Alpha ",
      awayTeamRaw: "Beta",
      competitionRaw: "   ",
      homeTeamNormalized: "alpha",
      awayTeamNormalized: "beta",
      competitionNormalized: "",
    });
    const b = snapshot("b", {
      homeTeamRaw: "Alpha",
      awayTeamRaw: "Beta",
      competitionRaw: "",
      homeTeamNormalized: "alpha",
      awayTeamNormalized: "beta",
      competitionNormalized: "",
    });
    embedBatch.mockResolvedValue(
      new Map<string, number[]>([
        ["Alpha", [1]],
        ["Beta", [2]],
      ]),
    );

    const score = await scoreCandidate(candidate(a, b), {
      ...DEFAULT_EVENT_MATCHER_CONFIG,
      embeddingEnabled: true,
    });

    expect(embedBatch).toHaveBeenCalledWith(["Alpha", "Beta"]);
    expect(score.embeddingTeam).toBe(1);
    expect(score.embeddingCompetition).toBeNull();
  });
});
