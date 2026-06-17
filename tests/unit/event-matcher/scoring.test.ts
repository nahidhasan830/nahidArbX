import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EVENT_MATCHER_CONFIG } from "../../../lib/event-matcher/config";
import { decideCandidate } from "../../../lib/event-matcher/policy";
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

  it("ignores FK club prefixes on stored normalized provider text", async () => {
    const score = await scoreCandidate(
      candidate(
        snapshot("a", {
          provider: "saba-sportsbook",
          homeTeamRaw: "Shurtan Guzar",
          homeTeamNormalized: "shurtan guzar",
          awayTeamRaw: "Metallurg Bekabad",
          awayTeamNormalized: "metallurg bekabad",
          competitionRaw: "UZBEKISTAN PRO LEAGUE",
          competitionNormalized: "uzbekistan pro league",
        }),
        snapshot("b", {
          provider: "ninewickets-sportsbook",
          homeTeamRaw: "FK Shortan Guzor",
          homeTeamNormalized: "fk shortan guzor",
          awayTeamRaw: "Metalourg Bekabad",
          awayTeamNormalized: "metalourg bekabad",
          competitionRaw: "Uzbekistan 1st Division",
          competitionNormalized: "uzbekistan 1st division",
        }),
      ),
      {
        ...DEFAULT_EVENT_MATCHER_CONFIG,
        embeddingEnabled: false,
      },
    );

    expect(score.orientation).toBe("same");
    expect(score.home).toBeGreaterThan(
      DEFAULT_EVENT_MATCHER_CONFIG.teamAutoMergeFloor,
    );
    expect(score.bestTeam).toBeGreaterThan(0.94);
  });

  it("normalizes reserve markers once both sides are reserve-context fixtures", async () => {
    const score = await scoreCandidate(
      candidate(
        snapshot("a", {
          provider: "pinnacle",
          homeTeamRaw: "Sarmiento",
          homeTeamNormalized: "sarmiento",
          awayTeamRaw: "Talleres de Cordoba",
          awayTeamNormalized: "talleres de cordoba",
          competitionRaw: "Argentina - Liga Pro Reserves",
          competitionNormalized: "argentina liga pro reserves",
        }),
        snapshot("b", {
          provider: "ninewickets-sportsbook",
          homeTeamRaw: "CA Sarmiento (Res)",
          homeTeamNormalized: "ca sarmiento res",
          awayTeamRaw: "CA Talleres de Cordoba (Res)",
          awayTeamNormalized: "ca talleres de cordoba res",
          competitionRaw: "Argentinian Primera Division Reserves",
          competitionNormalized: "argentinian primera division reserves",
        }),
      ),
      {
        ...DEFAULT_EVENT_MATCHER_CONFIG,
        embeddingEnabled: false,
      },
    );

    expect(score.home).toBe(1);
    expect(score.away).toBe(1);
    expect(score.orientation).toBe("same");

    const decision = decideCandidate([], score, DEFAULT_EVENT_MATCHER_CONFIG);
    expect(decision.decision).toBe("auto_merge");
    expect(decision.reasonCode).toBe("exact_team_kickoff_match");
  });

  it("does not let shared youth markers inflate unrelated team similarity", async () => {
    const score = await scoreCandidate(
      candidate(
        snapshot("a", {
          provider: "saba-sportsbook",
          homeTeamRaw: "Grorud IL U19",
          homeTeamNormalized: "grorud il u19",
          awayTeamRaw: "Valdres FK U19",
          awayTeamNormalized: "valdres fk u19",
          competitionRaw: "NORWAY U19 INTERKRETS B",
          competitionNormalized: "norway u19 interkrets b",
        }),
        snapshot("b", {
          provider: "ninewickets-sportsbook",
          homeTeamRaw: "Sarpsborg FK U19",
          homeTeamNormalized: "sarpsborg fk u19",
          awayTeamRaw: "Lorenskog U19",
          awayTeamNormalized: "lorenskog u19",
          competitionRaw: "Norwegian Interkretsserie U19 B",
          competitionNormalized: "norwegian interkretsserie u19 b",
        }),
      ),
      {
        ...DEFAULT_EVENT_MATCHER_CONFIG,
        embeddingEnabled: false,
      },
    );

    expect(score.home).toBeLessThanOrEqual(0.55);
    expect(score.away).toBeLessThanOrEqual(0.55);

    const decision = decideCandidate([], score, {
      ...DEFAULT_EVENT_MATCHER_CONFIG,
      embeddingEnabled: false,
    });
    expect(decision.decision).toBe("auto_reject");
    expect(decision.reasonCode).toBe("low_team_competition_similarity");
  });

  it("does not let shared women markers inflate unrelated national teams", async () => {
    const score = await scoreCandidate(
      candidate(
        snapshot("a", {
          provider: "ninewickets-sportsbook",
          homeTeamRaw: "Georgia (W)",
          homeTeamNormalized: "georgia w",
          awayTeamRaw: "Greece (W)",
          awayTeamNormalized: "greece w",
          competitionRaw: "FIFA Ladies World Cup Qualifiers",
          competitionNormalized: "fifa ladies world cup qualifiers",
        }),
        snapshot("b", {
          provider: "velki-sportsbook",
          homeTeamRaw: "Serbia (W)",
          homeTeamNormalized: "serbia w",
          awayTeamRaw: "Denmark (W)",
          awayTeamNormalized: "denmark w",
          competitionRaw: "FIFA Ladies World Cup Qualifiers",
          competitionNormalized: "fifa ladies world cup qualifiers",
        }),
      ),
      {
        ...DEFAULT_EVENT_MATCHER_CONFIG,
        embeddingEnabled: false,
      },
    );

    expect(score.home).toBeLessThanOrEqual(0.55);
    expect(score.away).toBeLessThanOrEqual(0.55);

    const decision = decideCandidate([], score, {
      ...DEFAULT_EVENT_MATCHER_CONFIG,
      embeddingEnabled: false,
    });
    expect(decision.decision).toBe("auto_reject");
    expect(decision.reasonCode).toBe("low_team_competition_similarity");
  });

  it("caps subset-only country and city token matches without breaking club prefixes", async () => {
    const subsetNoise = await scoreCandidate(
      candidate(
        snapshot("a", {
          homeTeamRaw: "Northern Ireland",
          homeTeamNormalized: "northern ireland",
          awayTeamRaw: "Guinea",
          awayTeamNormalized: "guinea",
          competitionRaw: "Friendlies International",
          competitionNormalized: "friendlies international",
        }),
        snapshot("b", {
          homeTeamRaw: "Burundi",
          homeTeamNormalized: "burundi",
          awayTeamRaw: "Equatorial Guinea",
          awayTeamNormalized: "equatorial guinea",
          competitionRaw: "International - Friendlies",
          competitionNormalized: "international friendlies",
        }),
      ),
      {
        ...DEFAULT_EVENT_MATCHER_CONFIG,
        embeddingEnabled: false,
      },
    );
    const knownPrefix = await scoreCandidate(
      candidate(
        snapshot("c", {
          homeTeamRaw: "Dortmund",
          homeTeamNormalized: "dortmund",
          awayTeamRaw: "Bayern Munich",
          awayTeamNormalized: "bayern munich",
          competitionRaw: "German Bundesliga",
          competitionNormalized: "german bundesliga",
        }),
        snapshot("d", {
          homeTeamRaw: "Borussia Dortmund",
          homeTeamNormalized: "borussia dortmund",
          awayTeamRaw: "Bayern Munchen",
          awayTeamNormalized: "bayern munchen",
          competitionRaw: "German Bundesliga",
          competitionNormalized: "german bundesliga",
        }),
      ),
      {
        ...DEFAULT_EVENT_MATCHER_CONFIG,
        embeddingEnabled: false,
      },
    );

    expect(subsetNoise.away).toBeLessThan(0.86);
    expect(knownPrefix.home).toBeGreaterThan(
      DEFAULT_EVENT_MATCHER_CONFIG.teamAutoMergeFloor,
    );
  });

  it("normalizes compact club initialisms when the opponent and competition also align", async () => {
    const score = await scoreCandidate(
      candidate(
        snapshot("a", {
          provider: "pinnacle",
          homeTeamRaw: "SIF",
          homeTeamNormalized: "sif",
          awayTeamRaw: "Lapuan Virkia",
          awayTeamNormalized: "lapuan virkia",
          competitionRaw: "Finland - Kolmonen",
          competitionNormalized: "finland kolmonen",
        }),
        snapshot("b", {
          provider: "saba-sportsbook",
          homeTeamRaw: "Sundom IF",
          homeTeamNormalized: "sundom if",
          awayTeamRaw: "Virkia",
          awayTeamNormalized: "virkia",
          competitionRaw: "FINLAND KOLMONEN",
          competitionNormalized: "finland kolmonen",
        }),
      ),
      {
        ...DEFAULT_EVENT_MATCHER_CONFIG,
        embeddingEnabled: false,
      },
    );

    expect(score.home).toBe(1);
    expect(score.away).toBe(1);
    expect(score.orientation).toBe("same");

    const decision = decideCandidate([], score, DEFAULT_EVENT_MATCHER_CONFIG);
    expect(decision.decision).toBe("auto_merge");
    expect(decision.reasonCode).toBe("exact_team_kickoff_match");
  });

  it("normalizes legal prefixes and regional suffixes without fixture-specific aliases", async () => {
    const score = await scoreCandidate(
      candidate(
        snapshot("a", {
          provider: "pinnacle",
          homeTeamRaw: "Leonico",
          homeTeamNormalized: "leonico",
          awayTeamRaw: "Barreiras",
          awayTeamNormalized: "barreiras",
          competitionRaw: "Brazil - Baiano 2",
          competitionNormalized: "brazil baiano 2",
        }),
        snapshot("b", {
          provider: "saba-sportsbook",
          homeTeamRaw: "AD Leonico BA",
          homeTeamNormalized: "ad leonico ba",
          awayTeamRaw: "Barreiras FC BA",
          awayTeamNormalized: "barreiras fc ba",
          competitionRaw: "BRAZIL CAMPEONATO BAIANO SERIE B",
          competitionNormalized: "brazil campeonato baiano serie b",
        }),
      ),
      {
        ...DEFAULT_EVENT_MATCHER_CONFIG,
        embeddingEnabled: false,
      },
    );

    expect(score.home).toBe(1);
    expect(score.away).toBe(1);
    expect(score.orientation).toBe("same");

    const decision = decideCandidate([], score, DEFAULT_EVENT_MATCHER_CONFIG);
    expect(decision.decision).toBe("auto_merge");
    expect(decision.reasonCode).toBe("exact_team_kickoff_match");
  });

  it("does not collapse unrelated regional-suffix teams with the same opponent", async () => {
    const score = await scoreCandidate(
      candidate(
        snapshot("a", {
          provider: "pinnacle",
          homeTeamRaw: "Bahia",
          homeTeamNormalized: "bahia",
          awayTeamRaw: "Barreiras",
          awayTeamNormalized: "barreiras",
          competitionRaw: "Brazil - Baiano 2",
          competitionNormalized: "brazil baiano 2",
        }),
        snapshot("b", {
          provider: "saba-sportsbook",
          homeTeamRaw: "AD Leonico BA",
          homeTeamNormalized: "ad leonico ba",
          awayTeamRaw: "Barreiras FC BA",
          awayTeamNormalized: "barreiras fc ba",
          competitionRaw: "BRAZIL CAMPEONATO BAIANO SERIE B",
          competitionNormalized: "brazil campeonato baiano serie b",
        }),
      ),
      {
        ...DEFAULT_EVENT_MATCHER_CONFIG,
        embeddingEnabled: false,
      },
    );

    expect(score.home).toBeLessThan(
      DEFAULT_EVENT_MATCHER_CONFIG.teamAutoMergeFloor,
    );

    const decision = decideCandidate([], score, DEFAULT_EVENT_MATCHER_CONFIG);
    expect(decision.decision).not.toBe("auto_merge");
  });

  it("normalizes women markers and leading FK compounds without weakening the gender hard blocker", async () => {
    const score = await scoreCandidate(
      candidate(
        snapshot("a", {
          provider: "ninewickets-sportsbook",
          homeTeamRaw: "LSK Kvinner (W)",
          homeTeamNormalized: "lsk kvinner w",
          awayTeamRaw: "Fortuna Alesund (W)",
          awayTeamNormalized: "fortuna alesund w",
          competitionRaw: "Norwegian Toppserien Ladies",
          competitionNormalized: "norwegian toppserien ladies",
        }),
        snapshot("b", {
          provider: "pinnacle",
          homeTeamRaw: "LSK",
          homeTeamNormalized: "lsk",
          awayTeamRaw: "AaFK Fortuna",
          awayTeamNormalized: "aafk fortuna",
          competitionRaw: "Norway - Toppserien Women",
          competitionNormalized: "norway toppserien women",
        }),
      ),
      {
        ...DEFAULT_EVENT_MATCHER_CONFIG,
        embeddingEnabled: false,
      },
    );

    expect(score.home).toBe(1);
    expect(score.away).toBe(1);
    expect(score.orientation).toBe("same");

    const decision = decideCandidate([], score, DEFAULT_EVENT_MATCHER_CONFIG);
    expect(decision.decision).toBe("auto_merge");
    expect(decision.reasonCode).toBe("exact_team_kickoff_match");
  });

  it("does not collapse different clubs that only share a city token and exact opponent", async () => {
    const score = await scoreCandidate(
      candidate(
        snapshot("a", {
          provider: "saba-sportsbook",
          homeTeamRaw: "IF Karlstad Fotbollutveckling",
          homeTeamNormalized: "if karlstad fotbollutveckling",
          awayTeamRaw: "IFK Skovde FK",
          awayTeamNormalized: "ifk skovde fk",
          competitionRaw: "SWEDEN 2ND DIVISION",
          competitionNormalized: "sweden 2nd division",
        }),
        snapshot("b", {
          provider: "ninewickets-sportsbook",
          homeTeamRaw: "FBK Karlstad 2",
          homeTeamNormalized: "fbk karlstad 2",
          awayTeamRaw: "Skovde",
          awayTeamNormalized: "skovde",
          competitionRaw: "Swedish Division 2",
          competitionNormalized: "swedish division 2",
        }),
      ),
      {
        ...DEFAULT_EVENT_MATCHER_CONFIG,
        embeddingEnabled: false,
      },
    );

    expect(score.home).toBeLessThan(
      DEFAULT_EVENT_MATCHER_CONFIG.teamAutoMergeFloor,
    );

    const decision = decideCandidate([], score, DEFAULT_EVENT_MATCHER_CONFIG);
    expect(decision.decision).not.toBe("auto_merge");
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
