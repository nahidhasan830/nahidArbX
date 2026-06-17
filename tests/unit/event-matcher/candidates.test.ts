import { describe, expect, it } from "vitest";
import { DEFAULT_EVENT_MATCHER_CONFIG } from "../../../lib/event-matcher/config";
import {
  candidateShapeFingerprintFor,
  generateCandidates,
  hardBlockersForCandidate,
} from "../../../lib/event-matcher/candidates";
import type { ProviderEventSnapshot } from "../../../lib/event-matcher/types";

function snap(
  id: string,
  provider: string,
  kickoff: Date,
  overrides: Partial<ProviderEventSnapshot> = {},
): ProviderEventSnapshot {
  return {
    id,
    provider,
    providerEventId: id,
    sport: "football",
    homeTeamRaw: "Team A",
    awayTeamRaw: "Team B",
    competitionRaw: "Premier League",
    homeTeamNormalized: "team a",
    awayTeamNormalized: "team b",
    competitionNormalized: "premier league",
    rawStartTime: kickoff.toISOString(),
    parsedKickoff: kickoff,
    parseStrategy: "test",
    fetchBatchId: "batch",
    providerMetadata: null,
    rawPayload: null,
    ...overrides,
  };
}

describe("event matcher candidate generation", () => {
  it("blocks same-provider pairs", () => {
    const a = snap("a", "pinnacle", new Date("2026-01-01T10:00:00Z"));
    const b = snap("b", "pinnacle", new Date("2026-01-01T10:01:00Z"));
    expect(
      hardBlockersForCandidate(a, b, DEFAULT_EVENT_MATCHER_CONFIG),
    ).toContain("same_provider");
  });

  it("blocks Saba offset windows instead of treating them as candidates", () => {
    const a = snap("a", "saba-sportsbook", new Date("2026-01-01T10:00:00Z"));
    const b = snap("b", "pinnacle", new Date("2026-01-01T13:00:00Z"));
    expect(
      hardBlockersForCandidate(a, b, DEFAULT_EVENT_MATCHER_CONFIG),
    ).toContain("kickoff_mismatch");
  });

  it("blocks senior-vs-reserve rows when only one side uses a parenthesized reserve marker", () => {
    const kickoff = new Date("2026-01-01T10:00:00Z");
    const a = snap("a", "pinnacle", kickoff, {
      homeTeamRaw: "Sarmiento",
      homeTeamNormalized: "sarmiento",
      awayTeamRaw: "Talleres de Cordoba",
      awayTeamNormalized: "talleres de cordoba",
      competitionRaw: "Argentina - Liga Pro",
      competitionNormalized: "argentina liga pro",
    });
    const b = snap("b", "ninewickets-sportsbook", kickoff, {
      homeTeamRaw: "CA Sarmiento (Res)",
      homeTeamNormalized: "ca sarmiento res",
      awayTeamRaw: "CA Talleres de Cordoba (Res)",
      awayTeamNormalized: "ca talleres de cordoba res",
      competitionRaw: "Argentinian Primera Division",
      competitionNormalized: "argentinian primera division",
    });

    expect(
      hardBlockersForCandidate(a, b, DEFAULT_EVENT_MATCHER_CONFIG),
    ).toContain("youth_or_tier_mismatch");
  });

  it("keeps same-kickoff pairs without anchors out of the candidate funnel", () => {
    const kickoff = new Date("2026-05-28T07:00:00Z");
    const a = snap("a", "saba-sportsbook", kickoff, {
      homeTeamRaw: "Melville United AFC",
      awayTeamRaw: "Tauranga City AFC",
      competitionRaw: "NEW ZEALAND NORTHERN LEAGUE",
      homeTeamNormalized: "melville united",
      awayTeamNormalized: "tauranga city",
      competitionNormalized: "new zealand northern league",
    });
    const b = snap("b", "velki-sportsbook", kickoff, {
      homeTeamRaw: "Hawassa Kima FC",
      awayTeamRaw: "Ethiopian Coffee",
      competitionRaw: "Ethiopian Premier League",
      homeTeamNormalized: "hawassa kima",
      awayTeamNormalized: "ethiopian coffee",
      competitionNormalized: "ethiopian premier league",
    });
    const candidates = generateCandidates(
      [a, b],
      DEFAULT_EVENT_MATCHER_CONFIG,
      "run",
    );
    expect(candidates).toHaveLength(0);
  });

  it("does not generate candidates when only the league is similar", () => {
    const kickoff = new Date("2026-05-28T07:00:00Z");
    const candidates = generateCandidates(
      [
        snap("a", "saba-sportsbook", kickoff, {
          homeTeamRaw: "Melville United AFC",
          awayTeamRaw: "Tauranga City AFC",
          competitionRaw: "New Zealand Northern League",
          homeTeamNormalized: "melville united",
          awayTeamNormalized: "tauranga city",
          competitionNormalized: "new zealand northern league",
        }),
        snap("b", "velki-sportsbook", kickoff, {
          homeTeamRaw: "Hawassa Kima FC",
          awayTeamRaw: "Ethiopian Coffee",
          competitionRaw: "New Zealand Northern League",
          homeTeamNormalized: "hawassa kima",
          awayTeamNormalized: "ethiopian coffee",
          competitionNormalized: "new zealand northern league",
        }),
      ],
      DEFAULT_EVENT_MATCHER_CONFIG,
      "run",
    );
    expect(candidates).toHaveLength(0);
  });

  it("generates candidates when exactly two text anchors are similar", () => {
    const kickoff = new Date("2026-05-28T07:00:00Z");
    const candidates = generateCandidates(
      [
        snap("a", "saba-sportsbook", kickoff, {
          homeTeamRaw: "Melville United AFC",
          awayTeamRaw: "Tauranga City AFC",
          competitionRaw: "New Zealand Northern League",
          homeTeamNormalized: "melville united",
          awayTeamNormalized: "tauranga city",
          competitionNormalized: "new zealand northern league",
        }),
        snap("b", "velki-sportsbook", kickoff, {
          homeTeamRaw: "Melville United",
          awayTeamRaw: "Ethiopian Coffee",
          competitionRaw: "New Zealand Northern League",
          homeTeamNormalized: "melville united",
          awayTeamNormalized: "ethiopian coffee",
          competitionNormalized: "new zealand northern league",
        }),
      ],
      DEFAULT_EVENT_MATCHER_CONFIG,
      "run",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].admission).toBe("hard_admit");
    expect(candidates[0].reasons).toEqual(
      expect.arrayContaining([
        "text_anchor_orientation:same",
        "candidate_admission:hard_admit",
        "text_anchor_count:2",
        "home_team_text_anchor",
        "competition_text_anchor",
      ]),
    );
  });

  it("does not generate candidates when only swapped team anchors are similar", () => {
    const kickoff = new Date("2026-05-28T07:00:00Z");
    const candidates = generateCandidates(
      [
        snap("a", "saba-sportsbook", kickoff, {
          homeTeamRaw: "Melville United AFC",
          awayTeamRaw: "Tauranga City AFC",
          competitionRaw: "New Zealand Northern League",
          homeTeamNormalized: "melville united",
          awayTeamNormalized: "tauranga city",
          competitionNormalized: "new zealand northern league",
        }),
        snap("b", "velki-sportsbook", kickoff, {
          homeTeamRaw: "Tauranga City",
          awayTeamRaw: "Melville United",
          competitionRaw: "Ethiopian Premier League",
          homeTeamNormalized: "tauranga city",
          awayTeamNormalized: "melville united",
          competitionNormalized: "ethiopian premier league",
        }),
      ],
      DEFAULT_EVENT_MATCHER_CONFIG,
      "run",
    );
    expect(candidates).toHaveLength(0);
  });

  it("LLM-admits exact-kickoff pairs with one strong team anchor", () => {
    const kickoff = new Date("2026-05-28T07:00:00Z");
    const candidates = generateCandidates(
      [
        snap("a", "saba-sportsbook", kickoff, {
          homeTeamRaw: "Manchester United",
          awayTeamRaw: "Chelsea",
          competitionRaw: "England Premier League",
          homeTeamNormalized: "manchester united",
          awayTeamNormalized: "chelsea",
          competitionNormalized: "england premier league",
        }),
        snap("b", "ninewickets-sportsbook", kickoff, {
          homeTeamRaw: "Man United",
          awayTeamRaw: "London Blue",
          competitionRaw: "Soccer",
          homeTeamNormalized: "man united",
          awayTeamNormalized: "london blue",
          competitionNormalized: "soccer",
        }),
      ],
      DEFAULT_EVENT_MATCHER_CONFIG,
      "run",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].admission).toBe("llm_admit");
    expect(candidates[0].reasons).toEqual(
      expect.arrayContaining([
        "kickoff_exact:true",
        "candidate_admission:llm_admit",
        `shape_fingerprint:${candidates[0].shapeFingerprint}`,
      ]),
    );
  });

  it("changes candidate shape fingerprint when meaningful metadata changes", () => {
    const kickoff = new Date("2026-05-28T07:00:00Z");
    const a = snap("a", "saba-sportsbook", kickoff, {
      providerMetadata: { leagueId: "league-a", ignored: "one" },
    });
    const b = snap("b", "velki-sportsbook", kickoff, {
      providerMetadata: { leagueId: "league-a", ignored: "one" },
    });
    const first = candidateShapeFingerprintFor(
      a,
      b,
      DEFAULT_EVENT_MATCHER_CONFIG,
    );
    const second = candidateShapeFingerprintFor(
      a,
      {
        ...b,
        providerMetadata: { leagueId: "league-b", ignored: "one" },
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );
    const ignoredOnly = candidateShapeFingerprintFor(
      {
        ...a,
        providerMetadata: { leagueId: "league-a", ignored: "changed" },
      },
      b,
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(second).not.toBe(first);
    expect(ignoredOnly).toBe(first);
  });

  it("does not generate Saba/Velki candidates for different events five hours apart", () => {
    const candidates = generateCandidates(
      [
        snap("a", "saba-sportsbook", new Date("2026-05-28T07:00:00Z"), {
          homeTeamRaw: "Melville United AFC",
          awayTeamRaw: "Tauranga City AFC",
          competitionRaw: "NEW ZEALAND NORTHERN LEAGUE",
          homeTeamNormalized: "melville united",
          awayTeamNormalized: "tauranga city",
          competitionNormalized: "new zealand northern league",
        }),
        snap("b", "velki-sportsbook", new Date("2026-05-28T12:00:00Z"), {
          homeTeamRaw: "Hawassa Kima FC",
          awayTeamRaw: "Ethiopian Coffee",
          competitionRaw: "Ethiopian Premier League",
          homeTeamNormalized: "hawassa kima",
          awayTeamNormalized: "ethiopian coffee",
          competitionNormalized: "ethiopian premier league",
        }),
      ],
      DEFAULT_EVENT_MATCHER_CONFIG,
      "run",
    );
    expect(candidates).toHaveLength(0);
  });

  it("blocks non-Saba pairs with different kickoff times", () => {
    const a = snap(
      "a",
      "ninewickets-sportsbook",
      new Date("2026-05-28T09:00:00Z"),
      {
        homeTeamRaw: "KF Ballkani U21",
        awayTeamRaw: "KF Dukagjini U21",
        competitionRaw: "Kosovan U21",
        homeTeamNormalized: "ballkani u21",
        awayTeamNormalized: "dukagjini u21",
        competitionNormalized: "kosovan u21",
      },
    );
    const b = snap("b", "velki-sportsbook", new Date("2026-05-28T15:30:00Z"), {
      homeTeamRaw: "Chrobry Glogow",
      awayTeamRaw: "LKS Lodz",
      competitionRaw: "Polish I Liga",
      homeTeamNormalized: "chrobry glogow",
      awayTeamNormalized: "lks lodz",
      competitionNormalized: "polish i liga",
    });
    expect(
      hardBlockersForCandidate(a, b, DEFAULT_EVENT_MATCHER_CONFIG),
    ).toContain("kickoff_mismatch");
  });

  it("generates only cross-provider candidates", () => {
    const base = new Date("2026-01-01T10:00:00Z");
    const candidates = generateCandidates(
      [
        snap("a", "pinnacle", base),
        snap("b", "betconstruct", base),
        snap("c", "pinnacle", base),
      ],
      DEFAULT_EVENT_MATCHER_CONFIG,
      "run",
    );
    expect(candidates).toHaveLength(2);
    expect(
      candidates.every((c) => c.snapshotA.provider !== c.snapshotB.provider),
    ).toBe(true);
  });

  it("does not generate non-Saba candidates with different kickoff times", () => {
    const candidates = generateCandidates(
      [
        snap("a", "ninewickets-sportsbook", new Date("2026-05-28T09:00:00Z")),
        snap("b", "velki-sportsbook", new Date("2026-05-28T15:30:00Z")),
      ],
      DEFAULT_EVENT_MATCHER_CONFIG,
      "run",
    );
    expect(candidates).toHaveLength(0);
  });
});
