import { describe, it, expect } from "vitest";
import {
  computeFlatMetrics,
  computeKellyQMetrics,
  brierScore,
  winZScore,
  clvPct,
  summarizeClv,
  evBucket,
  oddsBucket,
} from "@/lib/bets-history/metrics";
import type { ValueBetRow } from "@/lib/bets-history/types";

function makeRow(overrides: Partial<ValueBetRow> = {}): ValueBetRow {
  return {
    id: "r1",
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

// ── computeFlatMetrics ────────────────────────────────────────────────────────

describe("computeFlatMetrics", () => {
  it("returns zeros for empty array", () => {
    const m = computeFlatMetrics([]);
    expect(m.settledBets).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.roiPct).toBe(0);
  });

  it("ignores pending bets", () => {
    const rows = [
      makeRow({ outcome: "pending" }),
      makeRow({ outcome: "pending" }),
    ];
    const m = computeFlatMetrics(rows);
    expect(m.settledBets).toBe(0);
  });

  it("counts wins, losses, half outcomes correctly", () => {
    const rows = [
      makeRow({ outcome: "won" }),
      makeRow({ outcome: "won" }),
      makeRow({ outcome: "lost" }),
      makeRow({ outcome: "half_won" }),
      makeRow({ outcome: "half_lost" }),
      makeRow({ outcome: "void" }),
    ];
    const m = computeFlatMetrics(rows);
    expect(m.settledBets).toBe(6);
    expect(m.wins).toBe(2);
    expect(m.losses).toBe(1);
    expect(m.halfWins).toBe(1);
    expect(m.halfLosses).toBe(1);
  });

  it("flat ROI: 100% win rate at 2.1 odds → positive ROI", () => {
    const rows = [
      makeRow({ outcome: "won", softOdds: 2.1 }),
      makeRow({ outcome: "won", softOdds: 2.1 }),
    ];
    const m = computeFlatMetrics(rows);
    expect(m.roiPct).toBeGreaterThan(0);
    expect(m.winRate).toBe(1);
  });

  it("100% loss rate → negative ROI", () => {
    const rows = [makeRow({ outcome: "lost" }), makeRow({ outcome: "lost" })];
    const m = computeFlatMetrics(rows);
    expect(m.roiPct).toBeLessThan(0);
    expect(m.wins).toBe(0);
  });
});

// ── computeKellyQMetrics ──────────────────────────────────────────────────────

describe("computeKellyQMetrics", () => {
  it("returns zeros for empty array", () => {
    const m = computeKellyQMetrics([]);
    expect(m.settledBets).toBe(0);
    expect(m.roiPct).toBe(0);
  });

  it("settledBets matches flat count", () => {
    const rows = [makeRow({ outcome: "won" }), makeRow({ outcome: "lost" })];
    expect(computeKellyQMetrics(rows).settledBets).toBe(2);
    expect(computeFlatMetrics(rows).settledBets).toBe(2);
  });

  it("ROI is positive for all-winning rows with edge", () => {
    const rows = [
      makeRow({ outcome: "won", softOdds: 2.2, sharpTrueProb: 0.5 }),
      makeRow({ outcome: "won", softOdds: 2.2, sharpTrueProb: 0.5 }),
    ];
    const m = computeKellyQMetrics(rows);
    expect(m.roiPct).toBeGreaterThan(0);
  });

  it("returns zero roiPct when total kelly stake is zero", () => {
    // softOdds=1.2, sharpTrueProb=0.8 → fair=1.25 → soft below fair → kelly=0
    const rows = [
      makeRow({ outcome: "lost", softOdds: 1.2, sharpTrueProb: 0.8 }),
    ];
    const m = computeKellyQMetrics(rows);
    // Kelly = max(0, ...) = 0, so totalStake = 0 → roiPct = 0
    expect(m.roiPct).toBe(0);
  });
});

// ── brierScore ────────────────────────────────────────────────────────────────

describe("brierScore", () => {
  it("returns null for empty array", () => {
    expect(brierScore([])).toBeNull();
  });

  it("returns null when only pending rows", () => {
    expect(brierScore([makeRow({ outcome: "pending" })])).toBeNull();
  });

  it("perfect calibration: prob=1 for all wins → brier=0", () => {
    const rows = [
      makeRow({ outcome: "won", sharpTrueProb: 1.0 }),
      makeRow({ outcome: "won", sharpTrueProb: 1.0 }),
    ];
    expect(brierScore(rows)).toBeCloseTo(0, 5);
  });

  it("worst calibration: prob=0 for wins → brier=1", () => {
    const rows = [makeRow({ outcome: "won", sharpTrueProb: 0.0 })];
    expect(brierScore(rows)).toBeCloseTo(1, 5);
  });

  it("ignores half_won, half_lost, void, pending", () => {
    const ignored = [
      makeRow({ outcome: "half_won", sharpTrueProb: 0.5 }),
      makeRow({ outcome: "void", sharpTrueProb: 0.5 }),
      makeRow({ outcome: "pending", sharpTrueProb: 0.5 }),
    ];
    expect(brierScore(ignored)).toBeNull();
  });
});

// ── winZScore ─────────────────────────────────────────────────────────────────

describe("winZScore", () => {
  it("returns null when fewer than 10 decided bets", () => {
    const rows = Array.from({ length: 9 }, () =>
      makeRow({ outcome: "won", sharpTrueProb: 0.5 }),
    );
    expect(winZScore(rows)).toBeNull();
  });

  it("returns positive z when wins > expected", () => {
    // 15 wins, all p=0.3 → expected = 4.5, much higher actual
    const rows = Array.from({ length: 15 }, () =>
      makeRow({ outcome: "won", sharpTrueProb: 0.3 }),
    );
    const z = winZScore(rows);
    expect(z).not.toBeNull();
    expect(z!).toBeGreaterThan(0);
  });

  it("returns negative z when wins < expected", () => {
    const rows = Array.from({ length: 15 }, () =>
      makeRow({ outcome: "lost", sharpTrueProb: 0.7 }),
    );
    const z = winZScore(rows);
    expect(z).not.toBeNull();
    expect(z!).toBeLessThan(0);
  });
});

// ── clvPct ────────────────────────────────────────────────────────────────────

describe("clvPct", () => {
  it("returns null when closingSharpOdds is null", () => {
    expect(clvPct(makeRow({ closingSharpOdds: null }))).toBeNull();
  });

  it("positive CLV when entry odds > closing sharp", () => {
    const row = makeRow({ softOdds: 2.2, closingSharpOdds: 2.0 });
    expect(clvPct(row)).toBeGreaterThan(0);
  });

  it("negative CLV when entry odds < closing sharp", () => {
    const row = makeRow({ softOdds: 1.8, closingSharpOdds: 2.0 });
    expect(clvPct(row)).toBeLessThan(0);
  });
});

// ── summarizeClv ──────────────────────────────────────────────────────────────

describe("summarizeClv", () => {
  it("returns zero withClosing when no rows have closing odds", () => {
    const rows = [makeRow({ closingSharpOdds: null })];
    const s = summarizeClv(rows);
    expect(s.withClosing).toBe(0);
    expect(s.meanPct).toBeNull();
  });

  it("computes mean CLV across rows", () => {
    const rows = [
      makeRow({ softOdds: 2.2, closingSharpOdds: 2.0 }),
      makeRow({ softOdds: 1.8, closingSharpOdds: 2.0 }),
    ];
    const s = summarizeClv(rows);
    expect(s.withClosing).toBe(2);
    expect(s.meanPct).toBeDefined();
  });
});

// ── bucket helpers ────────────────────────────────────────────────────────────

describe("evBucket", () => {
  it("neg for negative EV", () => {
    expect(evBucket(-1)).toBe("neg");
  });
  it("0-2% bucket", () => {
    expect(evBucket(1.5)).toBe("0–2%");
  });
  it("2-5% bucket", () => {
    expect(evBucket(3)).toBe("2–5%");
  });
  it("5-10% bucket", () => {
    expect(evBucket(7)).toBe("5–10%");
  });
  it("10%+ bucket", () => {
    expect(evBucket(15)).toBe("10%+");
  });
});

describe("oddsBucket", () => {
  it("below 1.5", () => {
    expect(oddsBucket(1.3)).toBe("<1.5");
  });
  it("1.5-2", () => {
    expect(oddsBucket(1.8)).toBe("1.5–2");
  });
  it("2-3", () => {
    expect(oddsBucket(2.5)).toBe("2–3");
  });
  it("3-5", () => {
    expect(oddsBucket(4)).toBe("3–5");
  });
  it("5+", () => {
    expect(oddsBucket(6)).toBe("5+");
  });
});
