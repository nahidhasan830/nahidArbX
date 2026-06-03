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
  it("expands narrow team abbreviations without treating shared suffixes as aliases", async () => {
    const manUnited = await scoreCandidate(
      candidate(
        snapshot("a", {
          homeTeamRaw: "Manchester United",
          homeTeamNormalized: "manchester united",
          awayTeamRaw: "Chelsea",
          awayTeamNormalized: "chelsea",
        }),
        snapshot("b", {
          homeTeamRaw: "Man United",
          homeTeamNormalized: "man united",
          awayTeamRaw: "Chelsea FC",
          awayTeamNormalized: "chelsea",
        }),
      ),
      {
        ...DEFAULT_EVENT_MATCHER_CONFIG,
        embeddingEnabled: false,
      },
    );
    const northSouth = await scoreCandidate(
      candidate(
        snapshot("c", {
          homeTeamRaw: "North United",
          homeTeamNormalized: "north united",
          awayTeamRaw: "Harbor City",
          awayTeamNormalized: "harbor city",
        }),
        snapshot("d", {
          homeTeamRaw: "South United",
          homeTeamNormalized: "south united",
          awayTeamRaw: "Harbor City",
          awayTeamNormalized: "harbor city",
        }),
      ),
      {
        ...DEFAULT_EVENT_MATCHER_CONFIG,
        embeddingEnabled: false,
      },
    );

    expect(manUnited.home).toBe(1);
    expect(northSouth.home).toBeLessThan(
      DEFAULT_EVENT_MATCHER_CONFIG.teamAutoMergeFloor,
    );
  });

  it("expands generic youth labels without aliasing specific age groups directly", async () => {
    const genericYouth = await scoreCandidate(
      candidate(
        snapshot("a", {
          homeTeamRaw: "China Youth",
          homeTeamNormalized: "china youth",
          awayTeamRaw: "DR Congo Youth",
          awayTeamNormalized: "dr congo youth",
        }),
        snapshot("b", {
          homeTeamRaw: "China U19",
          homeTeamNormalized: "china u19",
          awayTeamRaw: "DR Congo U23",
          awayTeamNormalized: "dr congo u23",
        }),
      ),
      {
        ...DEFAULT_EVENT_MATCHER_CONFIG,
        embeddingEnabled: false,
      },
    );
    const specificAgeMismatch = await scoreCandidate(
      candidate(
        snapshot("c", {
          homeTeamRaw: "China U19",
          homeTeamNormalized: "china u19",
          awayTeamRaw: "DR Congo U19",
          awayTeamNormalized: "dr congo u19",
        }),
        snapshot("d", {
          homeTeamRaw: "China U23",
          homeTeamNormalized: "china u23",
          awayTeamRaw: "DR Congo U23",
          awayTeamNormalized: "dr congo u23",
        }),
      ),
      {
        ...DEFAULT_EVENT_MATCHER_CONFIG,
        embeddingEnabled: false,
      },
    );

    expect(genericYouth.home).toBe(1);
    expect(genericYouth.away).toBe(1);
    expect(specificAgeMismatch.bestTeam).toBeLessThan(1);
  });

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
