import { describe, it, expect } from "vitest";
import { settleBet } from "@/lib/settle/settle-bet";
import type { ValueBetRow } from "@/lib/bets-history/types";
import type { MatchScore } from "@/lib/settle/types";

function makeRow(overrides: Partial<ValueBetRow> = {}): ValueBetRow {
  return {
    id: "test",
    eventId: "evt1",
    familyId: "fam1",
    atomId: "ft_home_win",
    atomLabel: "Home Win",
    homeTeam: "A",
    awayTeam: "B",
    competition: null,
    eventStartTime: "2026-01-01T15:00:00Z",
    marketType: "MATCH_RESULT",
    timeScope: "FT",
    familyLine: null,
    sharpProvider: "pinnacle",
    sharpOdds: 2.0,
    sharpTrueProb: 0.5,
    sharpOddsAgeMs: null,
    softProvider: "ninewickets-sportsbook",
    softCommissionPct: 0,
    softOdds: 2.1,
    firstSeenAt: "2026-01-01T12:00:00Z",
    lastSeenAt: "2026-01-01T12:00:00Z",
    tickCount: 1,
    closingSharpOdds: null,
    closingSoftOdds: null,
    outcome: "pending",
    outcomeMarkedAt: null,
    settledBySource: null,
    settleAttempts: 0,
    lastSettleAttemptAt: null,
    createdAt: "2026-01-01T12:00:00Z",
    updatedAt: "2026-01-01T12:00:00Z",
    ...overrides,
  };
}

function makeScore(overrides: Partial<MatchScore> = {}): MatchScore {
  return {
    eventId: "evt1",
    ftHome: 2,
    ftAway: 1,
    htHome: 1,
    htAway: 0,
    status: "FT",
    source: "espn",
    confidence: 1,
    ...overrides,
  };
}

// ── Status overrides ─────────────────────────────────────────────────────────

describe("settleBet — match status", () => {
  it("voids abandoned matches", () => {
    const result = settleBet(makeRow(), makeScore({ status: "ABD" }));
    expect(result.outcome).toBe("void");
    expect(result.reason).toBe("abandoned");
  });

  it("voids postponed matches", () => {
    const result = settleBet(makeRow(), makeScore({ status: "POSTPONED" }));
    expect(result.outcome).toBe("void");
    expect(result.reason).toBe("postponed");
  });
});

// ── MATCH_RESULT ─────────────────────────────────────────────────────────────

describe("settleBet — MATCH_RESULT", () => {
  it("home win: ft_home_win wins", () => {
    const row = makeRow({ atomId: "ft_home_win" });
    const result = settleBet(row, makeScore({ ftHome: 2, ftAway: 1 }));
    expect(result.outcome).toBe("won");
    expect(result.scopeScore).toBe("2-1");
  });

  it("home win: ft_home_win loses on away win", () => {
    const row = makeRow({ atomId: "ft_home_win" });
    const result = settleBet(row, makeScore({ ftHome: 1, ftAway: 2 }));
    expect(result.outcome).toBe("lost");
  });

  it("home win: ft_home_win loses on draw", () => {
    const row = makeRow({ atomId: "ft_home_win" });
    const result = settleBet(row, makeScore({ ftHome: 1, ftAway: 1 }));
    expect(result.outcome).toBe("lost");
  });

  it("draw: ft_draw wins on draw", () => {
    const row = makeRow({ atomId: "ft_draw" });
    const result = settleBet(row, makeScore({ ftHome: 1, ftAway: 1 }));
    expect(result.outcome).toBe("won");
  });

  it("away win: ft_away_win wins", () => {
    const row = makeRow({ atomId: "ft_away_win" });
    const result = settleBet(row, makeScore({ ftHome: 0, ftAway: 3 }));
    expect(result.outcome).toBe("won");
  });

  it("1H scope uses half-time score", () => {
    const row = makeRow({ atomId: "1h_home_win", timeScope: "1H" });
    // FT 2-1, HT 0-1 → home lost at HT
    const result = settleBet(
      row,
      makeScore({ ftHome: 2, ftAway: 1, htHome: 0, htAway: 1 }),
    );
    expect(result.outcome).toBe("lost");
  });

  it("2H scope uses second-half score (FT - HT)", () => {
    const row = makeRow({ atomId: "2h_home_win", timeScope: "2H" });
    // FT 2-1, HT 0-1 → 2H = 2-0 → home wins
    const result = settleBet(
      row,
      makeScore({ ftHome: 2, ftAway: 1, htHome: 0, htAway: 1 }),
    );
    expect(result.outcome).toBe("won");
  });

  it("1H returns pending when HT score missing", () => {
    const row = makeRow({ atomId: "1h_home_win", timeScope: "1H" });
    const result = settleBet(
      row,
      makeScore({
        htHome: null as unknown as number,
        htAway: null as unknown as number,
      }),
    );
    expect(result.outcome).toBe("pending");
    expect(result.reason).toBe("missing-ht-score");
  });
});

// ── OVER_UNDER ────────────────────────────────────────────────────────────────

describe("settleBet — OVER_UNDER", () => {
  it("over 2.5 wins with 3 goals", () => {
    const row = makeRow({
      marketType: "OVER_UNDER",
      atomId: "ft_total_over_2_5",
      familyLine: 2.5,
    });
    const result = settleBet(row, makeScore({ ftHome: 2, ftAway: 1 }));
    expect(result.outcome).toBe("won");
  });

  it("over 2.5 loses with 2 goals", () => {
    const row = makeRow({
      marketType: "OVER_UNDER",
      atomId: "ft_total_over_2_5",
      familyLine: 2.5,
    });
    const result = settleBet(row, makeScore({ ftHome: 1, ftAway: 1 }));
    expect(result.outcome).toBe("lost");
  });

  it("under 2.5 wins with 2 goals", () => {
    const row = makeRow({
      marketType: "OVER_UNDER",
      atomId: "ft_total_under_2_5",
      familyLine: 2.5,
    });
    const result = settleBet(row, makeScore({ ftHome: 1, ftAway: 1 }));
    expect(result.outcome).toBe("won");
  });

  it("over 2 voids on exactly 2 goals (integer line push)", () => {
    const row = makeRow({
      marketType: "OVER_UNDER",
      atomId: "ft_total_over_2",
      familyLine: 2.0,
    });
    const result = settleBet(row, makeScore({ ftHome: 1, ftAway: 1 }));
    expect(result.outcome).toBe("void");
  });

  it("over 2.25 (quarter line) — half_won on exactly 2 goals", () => {
    // 2.25 splits to [2, 2.5]; total=2: leg1=void (push), leg2=lost → half_lost
    // Actually: over 2 on total 2 → void; over 2.5 on total 2 → lost; fold(void, lost) = half_lost
    const row = makeRow({
      marketType: "OVER_UNDER",
      atomId: "ft_total_over_2_25",
      familyLine: 2.25,
    });
    const result = settleBet(row, makeScore({ ftHome: 1, ftAway: 1 }));
    expect(result.outcome).toBe("half_lost");
  });

  it("over 2.25 — half_won on 3 goals", () => {
    // 2.25 splits to [2, 2.5]; total=3: leg1=won, leg2=won → won
    const row = makeRow({
      marketType: "OVER_UNDER",
      atomId: "ft_total_over_2_25",
      familyLine: 2.25,
    });
    const result = settleBet(row, makeScore({ ftHome: 2, ftAway: 1 }));
    expect(result.outcome).toBe("won");
  });
});

// ── ASIAN_HANDICAP ────────────────────────────────────────────────────────────

describe("settleBet — ASIAN_HANDICAP", () => {
  it("home -0.5 wins when home wins by 1+", () => {
    const row = makeRow({
      marketType: "ASIAN_HANDICAP",
      atomId: "ft_home_ah_m0_5",
      familyLine: -0.5,
    });
    const result = settleBet(row, makeScore({ ftHome: 2, ftAway: 1 }));
    expect(result.outcome).toBe("won");
  });

  it("home -0.5 loses on draw", () => {
    const row = makeRow({
      marketType: "ASIAN_HANDICAP",
      atomId: "ft_home_ah_m0_5",
      familyLine: -0.5,
    });
    const result = settleBet(row, makeScore({ ftHome: 1, ftAway: 1 }));
    expect(result.outcome).toBe("lost");
  });

  it("home 0 (AH level) voids on draw", () => {
    const row = makeRow({
      marketType: "ASIAN_HANDICAP",
      atomId: "ft_home_ah_p0",
      familyLine: 0,
    });
    const result = settleBet(row, makeScore({ ftHome: 1, ftAway: 1 }));
    expect(result.outcome).toBe("void");
  });
});

// ── BTTS ──────────────────────────────────────────────────────────────────────

describe("settleBet — BTTS", () => {
  it("btts yes wins when both teams score", () => {
    const row = makeRow({
      marketType: "BTTS",
      atomId: "ft_btts_yes",
    });
    const result = settleBet(row, makeScore({ ftHome: 1, ftAway: 1 }));
    expect(result.outcome).toBe("won");
  });

  it("btts yes loses when only one team scores", () => {
    const row = makeRow({
      marketType: "BTTS",
      atomId: "ft_btts_yes",
    });
    const result = settleBet(row, makeScore({ ftHome: 2, ftAway: 0 }));
    expect(result.outcome).toBe("lost");
  });

  it("btts no wins when a team fails to score", () => {
    const row = makeRow({
      marketType: "BTTS",
      atomId: "ft_btts_no",
    });
    const result = settleBet(row, makeScore({ ftHome: 2, ftAway: 0 }));
    expect(result.outcome).toBe("won");
  });
});

// ── DNB ───────────────────────────────────────────────────────────────────────

describe("settleBet — DNB", () => {
  it("dnb home wins when home wins", () => {
    const row = makeRow({ marketType: "DNB", atomId: "ft_dnb_home" });
    const result = settleBet(row, makeScore({ ftHome: 2, ftAway: 1 }));
    expect(result.outcome).toBe("won");
  });

  it("dnb home voids on draw", () => {
    const row = makeRow({ marketType: "DNB", atomId: "ft_dnb_home" });
    const result = settleBet(row, makeScore({ ftHome: 1, ftAway: 1 }));
    expect(result.outcome).toBe("void");
  });

  it("dnb home loses on away win", () => {
    const row = makeRow({ marketType: "DNB", atomId: "ft_dnb_home" });
    const result = settleBet(row, makeScore({ ftHome: 0, ftAway: 1 }));
    expect(result.outcome).toBe("lost");
  });
});

// ── Unsupported market ────────────────────────────────────────────────────────

describe("settleBet — unsupported market", () => {
  it("returns pending with unsupported-market reason", () => {
    const row = makeRow({ marketType: "EUROPEAN_HANDICAP" });
    const result = settleBet(row, makeScore());
    expect(result.outcome).toBe("pending");
    expect(result.reason).toBe("unsupported-market");
  });
});
