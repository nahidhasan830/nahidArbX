/**
 * Comprehensive smoke test for the settlement pipeline.
 * Tests every supported market type × scope × line variant against known scores.
 */
import { describe, it, expect } from "vitest";
import { settleBet } from "@/lib/settle/settle-bet";
import type { ValueBetRow } from "@/lib/bets-history/types";
import type { MatchScore } from "@/lib/settle/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function row(overrides: Partial<ValueBetRow> = {}): ValueBetRow {
  return {
    id: "test", eventId: "evt1", familyId: "fam1", atomId: "ft_home_win",
    atomLabel: "Home Win", homeTeam: "A", awayTeam: "B", competition: null,
    eventStartTime: "2026-01-01T15:00:00Z", marketType: "MATCH_RESULT",
    timeScope: "FT", familyLine: null, sharpProvider: "pinnacle",
    sharpOdds: 2.0, sharpTrueProb: 0.5, softProvider: "ninewickets-sportsbook",
    softCommissionPct: 0, softOdds: 2.1, firstSeenAt: "2026-01-01T12:00:00Z",
    lastSeenAt: "2026-01-01T12:00:00Z", tickCount: 1, closingSharpOdds: null,
    outcome: "pending", settledBySource: null, settledAt: null,
    settleAttempts: 0, lastSettleAttemptAt: null, ...overrides,
  };
}

function score(overrides: Partial<MatchScore> = {}): MatchScore {
  return {
    eventId: "evt1", ftHome: 2, ftAway: 1, htHome: 1, htAway: 0,
    status: "FT", source: "espn", confidence: 1, ...overrides,
  };
}

// ── MATCH_RESULT scopes ──────────────────────────────────────────────────────

describe("smoke: MATCH_RESULT scopes", () => {
  // FT 2-1, HT 1-0 → 2H = 1-1
  it("FT home win", () => {
    expect(settleBet(row({ atomId: "ft_home_win" }), score()).outcome).toBe("won");
  });
  it("FT draw loses for home", () => {
    expect(settleBet(row({ atomId: "ft_home_win" }), score({ ftHome: 1, ftAway: 1 })).outcome).toBe("lost");
  });
  it("1H home win at halftime", () => {
    expect(settleBet(row({ atomId: "1h_home_win", timeScope: "1H" }), score()).outcome).toBe("won");
  });
  it("2H draw", () => {
    // FT 2-1, HT 1-0 → 2H = 1-1 = draw
    expect(settleBet(row({ atomId: "2h_draw", timeScope: "2H" }), score()).outcome).toBe("won");
  });
  it("2H away win", () => {
    // FT 2-3, HT 1-0 → 2H = 1-3 → away wins
    expect(settleBet(row({ atomId: "2h_away_win", timeScope: "2H" }), score({ ftHome: 2, ftAway: 3 })).outcome).toBe("won");
  });
});

// ── OVER_UNDER edge cases ────────────────────────────────────────────────────

describe("smoke: OVER_UNDER edge cases", () => {
  it("over 0.5 wins on 1 goal", () => {
    const r = row({ marketType: "OVER_UNDER", atomId: "ft_total_over_0_5", familyLine: 0.5 });
    expect(settleBet(r, score({ ftHome: 1, ftAway: 0 })).outcome).toBe("won");
  });
  it("under 0.5 wins on 0 goals", () => {
    const r = row({ marketType: "OVER_UNDER", atomId: "ft_total_under_0_5", familyLine: 0.5 });
    expect(settleBet(r, score({ ftHome: 0, ftAway: 0 })).outcome).toBe("won");
  });
  it("over 2.75 quarter line half_won on 3 goals", () => {
    // 2.75 → [2.5, 3]: total=3 → leg1=won, leg2=void → half_won
    const r = row({ marketType: "OVER_UNDER", atomId: "ft_total_over_2_75", familyLine: 2.75 });
    expect(settleBet(r, score({ ftHome: 2, ftAway: 1 })).outcome).toBe("half_won");
  });
  it("under 2.75 quarter line half_lost on 3 goals", () => {
    const r = row({ marketType: "OVER_UNDER", atomId: "ft_total_under_2_75", familyLine: 2.75 });
    expect(settleBet(r, score({ ftHome: 2, ftAway: 1 })).outcome).toBe("half_lost");
  });
  it("1H scope over 0.5 with HT 1-0", () => {
    const r = row({ marketType: "OVER_UNDER", atomId: "1h_total_over_0_5", familyLine: 0.5, timeScope: "1H" });
    expect(settleBet(r, score()).outcome).toBe("won");
  });
});

// ── ASIAN_HANDICAP edge cases ────────────────────────────────────────────────

describe("smoke: ASIAN_HANDICAP edge cases", () => {
  it("away +0.5 wins on draw", () => {
    const r = row({ marketType: "ASIAN_HANDICAP", atomId: "ft_away_ah_p0_5", familyLine: 0.5 });
    expect(settleBet(r, score({ ftHome: 1, ftAway: 1 })).outcome).toBe("won");
  });
  it("home -1.5 loses on 1-goal margin", () => {
    const r = row({ marketType: "ASIAN_HANDICAP", atomId: "ft_home_ah_m1_5", familyLine: -1.5 });
    expect(settleBet(r, score({ ftHome: 2, ftAway: 1 })).outcome).toBe("lost");
  });
  it("home -0.25 quarter line half_lost on draw", () => {
    // -0.25 → [0, -0.5]: draw → leg1=void, leg2=lost → half_lost
    const r = row({ marketType: "ASIAN_HANDICAP", atomId: "ft_home_ah_m0_25", familyLine: -0.25 });
    expect(settleBet(r, score({ ftHome: 1, ftAway: 1 })).outcome).toBe("half_lost");
  });
  it("home -0.75 quarter line won on 2-goal margin", () => {
    // -0.75 → [-0.5, -1]: diff=2-1=1 → leg1=won(1-0.5>0), leg2=void(1-1=0)? No:
    // AH: (home-away)+line → leg1: (2-1)+(-0.5)=0.5>0 → won; leg2: (2-1)+(-1)=0 → void → half_won
    // Wait, 2-0 with -0.75: (2-0)+(-0.5)=1.5>0 → won; (2-0)+(-1)=1>0 → won → won
    const r = row({ marketType: "ASIAN_HANDICAP", atomId: "ft_home_ah_m0_75", familyLine: -0.75 });
    expect(settleBet(r, score({ ftHome: 2, ftAway: 0 })).outcome).toBe("won");
  });
});

// ── DOUBLE_CHANCE ────────────────────────────────────────────────────────────

describe("smoke: DOUBLE_CHANCE", () => {
  it("1x wins on home win", () => {
    const r = row({ marketType: "DOUBLE_CHANCE", atomId: "ft_dc_1x" });
    expect(settleBet(r, score({ ftHome: 2, ftAway: 1 })).outcome).toBe("won");
  });
  it("1x wins on draw", () => {
    const r = row({ marketType: "DOUBLE_CHANCE", atomId: "ft_dc_1x" });
    expect(settleBet(r, score({ ftHome: 1, ftAway: 1 })).outcome).toBe("won");
  });
  it("1x loses on away win", () => {
    const r = row({ marketType: "DOUBLE_CHANCE", atomId: "ft_dc_1x" });
    expect(settleBet(r, score({ ftHome: 0, ftAway: 2 })).outcome).toBe("lost");
  });
  it("x2 wins on draw", () => {
    const r = row({ marketType: "DOUBLE_CHANCE", atomId: "ft_dc_x2" });
    expect(settleBet(r, score({ ftHome: 1, ftAway: 1 })).outcome).toBe("won");
  });
  it("12 wins on home or away win", () => {
    const r = row({ marketType: "DOUBLE_CHANCE", atomId: "ft_dc_12" });
    expect(settleBet(r, score({ ftHome: 2, ftAway: 1 })).outcome).toBe("won");
    expect(settleBet(r, score({ ftHome: 0, ftAway: 1 })).outcome).toBe("won");
  });
  it("12 loses on draw", () => {
    const r = row({ marketType: "DOUBLE_CHANCE", atomId: "ft_dc_12" });
    expect(settleBet(r, score({ ftHome: 1, ftAway: 1 })).outcome).toBe("lost");
  });
});

// ── HOME_TEAM_TOTAL / AWAY_TEAM_TOTAL ────────────────────────────────────────

describe("smoke: team totals", () => {
  it("home total over 1.5 wins with 2 home goals", () => {
    const r = row({ marketType: "HOME_TEAM_TOTAL", atomId: "ft_home_over_1_5", familyLine: 1.5 });
    expect(settleBet(r, score({ ftHome: 2, ftAway: 0 })).outcome).toBe("won");
  });
  it("away total under 0.5 wins with 0 away goals", () => {
    const r = row({ marketType: "AWAY_TEAM_TOTAL", atomId: "ft_away_under_0_5", familyLine: 0.5 });
    expect(settleBet(r, score({ ftHome: 2, ftAway: 0 })).outcome).toBe("won");
  });
  it("away total over 0.5 loses with 0 away goals", () => {
    const r = row({ marketType: "AWAY_TEAM_TOTAL", atomId: "ft_away_over_0_5", familyLine: 0.5 });
    expect(settleBet(r, score({ ftHome: 2, ftAway: 0 })).outcome).toBe("lost");
  });
});

// ── EUROPEAN_HANDICAP (NEW) ──────────────────────────────────────────────────

describe("smoke: EUROPEAN_HANDICAP", () => {
  it("home EH -1 wins when home wins by 2+", () => {
    // handicap -1 → adjHome = 3-1=2, adjAway = 1 → home wins
    const r = row({ marketType: "EUROPEAN_HANDICAP", atomId: "ft_home_eh_m1", familyLine: -1 });
    expect(settleBet(r, score({ ftHome: 3, ftAway: 1 })).outcome).toBe("won");
  });
  it("draw EH -1 wins when home wins by exactly 1", () => {
    // handicap -1 → adjHome = 2-1=1, adjAway = 1 → draw
    const r = row({ marketType: "EUROPEAN_HANDICAP", atomId: "ft_draw_eh_m1", familyLine: -1 });
    expect(settleBet(r, score({ ftHome: 2, ftAway: 1 })).outcome).toBe("won");
  });
  it("away EH -1 wins when match is a draw (adj: draw-1 vs away)", () => {
    // handicap -1 → adjHome = 1-1=0, adjAway = 1 → away wins
    const r = row({ marketType: "EUROPEAN_HANDICAP", atomId: "ft_away_eh_m1", familyLine: -1 });
    expect(settleBet(r, score({ ftHome: 1, ftAway: 1 })).outcome).toBe("won");
  });
  it("home EH +1 wins when match is a draw", () => {
    // handicap +1 → adjHome = 1+1=2, adjAway = 1 → home wins
    const r = row({ marketType: "EUROPEAN_HANDICAP", atomId: "ft_home_eh_p1", familyLine: 1 });
    expect(settleBet(r, score({ ftHome: 1, ftAway: 1 })).outcome).toBe("won");
  });
});

// ── CORNERS (OU) ─────────────────────────────────────────────────────────────

describe("smoke: CORNERS", () => {
  const cornersScore = (ch: number, ca: number) =>
    score({ cornersHome: ch, cornersAway: ca });

  it("total corners over 9.5 wins with 11 corners", () => {
    const r = row({ marketType: "CORNERS", atomId: "ft_total_over_9_5", familyLine: 9.5 });
    expect(settleBet(r, cornersScore(6, 5)).outcome).toBe("won");
  });
  it("total corners under 9.5 loses with 11 corners", () => {
    const r = row({ marketType: "CORNERS", atomId: "ft_total_under_9_5", familyLine: 9.5 });
    expect(settleBet(r, cornersScore(6, 5)).outcome).toBe("lost");
  });
  it("home corners over 4.5 wins with 6 home corners", () => {
    const r = row({ marketType: "HOME_CORNERS_TOTAL", atomId: "ft_home_over_4_5", familyLine: 4.5 });
    expect(settleBet(r, cornersScore(6, 5)).outcome).toBe("won");
  });
  it("away corners under 4.5 wins with 3 away corners", () => {
    const r = row({ marketType: "AWAY_CORNERS_TOTAL", atomId: "ft_away_under_4_5", familyLine: 4.5 });
    expect(settleBet(r, cornersScore(6, 3)).outcome).toBe("won");
  });
  it("pending when corners not fetched", () => {
    const r = row({ marketType: "CORNERS", atomId: "ft_total_over_9_5", familyLine: 9.5 });
    expect(settleBet(r, score()).outcome).toBe("pending");
  });
});

// ── CORNERS_HANDICAP (NEW) ───────────────────────────────────────────────────

describe("smoke: CORNERS_HANDICAP", () => {
  const cs = (ch: number, ca: number) =>
    score({ cornersHome: ch, cornersAway: ca });

  it("home -1.5 corners wins when home has 2+ more corners", () => {
    // home=7, away=4, line=-1.5 → diff=(7-4)+(-1.5)=1.5>0 → won
    const r = row({ marketType: "CORNERS_HANDICAP", atomId: "ft_home_ah_m1_5", familyLine: -1.5 });
    expect(settleBet(r, cs(7, 4)).outcome).toBe("won");
  });
  it("away +1.5 corners wins when gap is ≤1", () => {
    // home=5, away=4, line=1.5 → diff=(4-5)+(1.5)=0.5>0 → won
    const r = row({ marketType: "CORNERS_HANDICAP", atomId: "ft_away_ah_p1_5", familyLine: 1.5 });
    expect(settleBet(r, cs(5, 4)).outcome).toBe("won");
  });
  it("pending when corners not fetched", () => {
    const r = row({ marketType: "CORNERS_HANDICAP", atomId: "ft_home_ah_m1_5", familyLine: -1.5 });
    expect(settleBet(r, score()).outcome).toBe("pending");
  });
});

// ── CORNERS_EUROPEAN_HANDICAP (NEW) ──────────────────────────────────────────

describe("smoke: CORNERS_EUROPEAN_HANDICAP", () => {
  const cs = (ch: number, ca: number) =>
    score({ cornersHome: ch, cornersAway: ca });

  it("home EH -2 corners wins when home has 3+ more", () => {
    // home=8, away=4, handicap=-2 → adj: 8-2=6 vs 4 → home wins
    const r = row({ marketType: "CORNERS_EUROPEAN_HANDICAP", atomId: "ft_home_eh_m2", familyLine: -2 });
    expect(settleBet(r, cs(8, 4)).outcome).toBe("won");
  });
  it("draw EH -2 when home has exactly 2 more", () => {
    // home=6, away=4, handicap=-2 → adj: 6-2=4 vs 4 → draw
    const r = row({ marketType: "CORNERS_EUROPEAN_HANDICAP", atomId: "ft_draw_eh_m2", familyLine: -2 });
    expect(settleBet(r, cs(6, 4)).outcome).toBe("won");
  });
  it("away EH -2 when home has fewer than 2 more", () => {
    // home=5, away=4, handicap=-2 → adj: 5-2=3 vs 4 → away wins
    const r = row({ marketType: "CORNERS_EUROPEAN_HANDICAP", atomId: "ft_away_eh_m2", familyLine: -2 });
    expect(settleBet(r, cs(5, 4)).outcome).toBe("won");
  });
});

// ── BOOKINGS ─────────────────────────────────────────────────────────────────

describe("smoke: BOOKINGS", () => {
  const bs = (bh: number, ba: number) =>
    score({ bookingsHome: bh, bookingsAway: ba });

  it("bookings over 3.5 wins with total 5", () => {
    const r = row({ marketType: "BOOKINGS", atomId: "ft_total_over_3_5", familyLine: 3.5 });
    expect(settleBet(r, bs(3, 2)).outcome).toBe("won");
  });
  it("bookings under 3.5 wins with total 3", () => {
    const r = row({ marketType: "BOOKINGS", atomId: "ft_total_under_3_5", familyLine: 3.5 });
    expect(settleBet(r, bs(2, 1)).outcome).toBe("won");
  });
  it("pending when bookings not fetched", () => {
    const r = row({ marketType: "BOOKINGS", atomId: "ft_total_over_3_5", familyLine: 3.5 });
    expect(settleBet(r, score()).outcome).toBe("pending");
  });
});

// ── BOOKINGS_HANDICAP ────────────────────────────────────────────────────────

describe("smoke: BOOKINGS_HANDICAP", () => {
  const bs = (bh: number, ba: number) =>
    score({ bookingsHome: bh, bookingsAway: ba });

  it("home bookings AH -0.5 wins when home has more booking pts", () => {
    // home=4, away=2, line=-0.5 → diff=(4-2)+(-0.5)=1.5>0 → won
    const r = row({ marketType: "BOOKINGS_HANDICAP", atomId: "ft_home_ah_m0_5", familyLine: -0.5 });
    expect(settleBet(r, bs(4, 2)).outcome).toBe("won");
  });
  it("away bookings AH +0.5 wins on equal bookings", () => {
    // home=3, away=3, line=0.5 → diff=(3-3)+(0.5)=0.5>0 → won
    const r = row({ marketType: "BOOKINGS_HANDICAP", atomId: "ft_away_ah_p0_5", familyLine: 0.5 });
    expect(settleBet(r, bs(3, 3)).outcome).toBe("won");
  });
});

// ── Status overrides ─────────────────────────────────────────────────────────

describe("smoke: status overrides apply to all markets", () => {
  it("ABD voids any market", () => {
    const r = row({ marketType: "OVER_UNDER", atomId: "ft_total_over_2_5", familyLine: 2.5 });
    expect(settleBet(r, score({ status: "ABD" })).outcome).toBe("void");
  });
  it("POSTPONED voids any market", () => {
    const r = row({ marketType: "ASIAN_HANDICAP", atomId: "ft_home_ah_m0_5", familyLine: -0.5 });
    expect(settleBet(r, score({ status: "POSTPONED" })).outcome).toBe("void");
  });
});

// ── Missing HT on non-FT scope ──────────────────────────────────────────────

describe("smoke: missing HT scope handling", () => {
  it("1H scope returns pending when HT null", () => {
    const r = row({ atomId: "1h_home_win", timeScope: "1H" });
    expect(settleBet(r, score({ htHome: null, htAway: null })).outcome).toBe("pending");
  });
  it("2H scope returns pending when HT null", () => {
    const r = row({ atomId: "2h_draw", timeScope: "2H" });
    expect(settleBet(r, score({ htHome: null, htAway: null })).outcome).toBe("pending");
  });
});

// ── Unknown atoms ────────────────────────────────────────────────────────────

describe("smoke: unknown atoms return pending", () => {
  it("MATCH_RESULT with garbage atom", () => {
    expect(settleBet(row({ atomId: "ft_garbage" }), score()).outcome).toBe("pending");
  });
  it("OVER_UNDER with no over/under in atom", () => {
    const r = row({ marketType: "OVER_UNDER", atomId: "ft_total_xyz", familyLine: 2.5 });
    expect(settleBet(r, score()).outcome).toBe("pending");
  });
});
