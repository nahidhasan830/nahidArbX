import { describe, it, expect } from "vitest";
import { derive, settlementPnl, kellyStake } from "@/lib/bets-history/derive";
import type { ValueBetRow } from "@/lib/bets-history/types";

function makeRow(overrides: Partial<ValueBetRow> = {}): ValueBetRow {
  return {
    id: "test",
    eventId: "evt1",
    familyId: "fam1",
    atomId: "ft_home_win",
    atomLabel: "Home Win",
    homeTeam: "A",
    awayTeam: "B",
    competition: "Test League",
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

describe("derive", () => {
  it("computes EV% for zero-commission row", () => {
    const row = makeRow({
      softOdds: 2.1,
      sharpTrueProb: 0.5,
      softCommissionPct: 0,
    });
    const { evPct } = derive(row);
    expect(evPct).toBeCloseTo(5.0, 4);
  });

  it("EV is zero at fair odds", () => {
    const row = makeRow({
      softOdds: 2.0,
      sharpTrueProb: 0.5,
      softCommissionPct: 0,
    });
    const { evPct } = derive(row);
    expect(evPct).toBeCloseTo(0, 5);
  });

  it("negative EV below fair odds", () => {
    const row = makeRow({
      softOdds: 1.9,
      sharpTrueProb: 0.5,
      softCommissionPct: 0,
    });
    const { evPct } = derive(row);
    expect(evPct).toBeLessThan(0);
  });

  it("commission reduces adjusted odds", () => {
    const plain = makeRow({
      softOdds: 2.2,
      softCommissionPct: 0,
      sharpTrueProb: 0.5,
    });
    const comm = makeRow({
      softOdds: 2.2,
      softCommissionPct: 5,
      sharpTrueProb: 0.5,
    });
    expect(derive(comm).softOddsAdjusted).toBeLessThan(
      derive(plain).softOddsAdjusted,
    );
  });

  it("Kelly fraction is positive when edge > 0", () => {
    const row = makeRow({
      softOdds: 2.1,
      sharpTrueProb: 0.5,
      softCommissionPct: 0,
    });
    expect(derive(row).kellyFraction).toBeGreaterThan(0);
  });

  it("Kelly fraction is zero when no edge", () => {
    const row = makeRow({
      softOdds: 1.9,
      sharpTrueProb: 0.5,
      softCommissionPct: 0,
    });
    expect(derive(row).kellyFraction).toBe(0);
  });
});

describe("settlementPnl", () => {
  const wonRow = makeRow({
    outcome: "won",
    softOdds: 2.0,
    softCommissionPct: 0,
  });
  const lostRow = makeRow({ outcome: "lost" });
  const voidRow = makeRow({ outcome: "void" });
  const halfWonRow = makeRow({
    outcome: "half_won",
    softOdds: 2.0,
    softCommissionPct: 0,
  });
  const halfLostRow = makeRow({ outcome: "half_lost" });

  it("won: profit = stake * (odds - 1)", () => {
    expect(settlementPnl(wonRow, 100)).toBeCloseTo(100, 5);
  });

  it("lost: P&L = -stake", () => {
    expect(settlementPnl(lostRow, 100)).toBe(-100);
  });

  it("void: P&L = 0", () => {
    expect(settlementPnl(voidRow, 100)).toBe(0);
  });

  it("half_won: profit = 0.5 * stake * (odds - 1)", () => {
    expect(settlementPnl(halfWonRow, 100)).toBeCloseTo(50, 5);
  });

  it("half_lost: P&L = -0.5 * stake", () => {
    expect(settlementPnl(halfLostRow, 100)).toBe(-50);
  });

  it("commission reduces won P&L", () => {
    const rowComm = makeRow({
      outcome: "won",
      softOdds: 2.0,
      softCommissionPct: 5,
    });
    expect(settlementPnl(rowComm, 100)).toBeLessThan(100);
  });

  it("pending: P&L = 0", () => {
    const pendingRow = makeRow({ outcome: "pending" });
    expect(settlementPnl(pendingRow, 100)).toBe(0);
  });
});

describe("kellyStake", () => {
  it("scales by multiplier and bankroll", () => {
    const row = makeRow({
      softOdds: 2.1,
      sharpTrueProb: 0.5,
      softCommissionPct: 0,
    });
    const s1 = kellyStake(row, 1000, 1);
    const s2 = kellyStake(row, 1000, 0.25);
    expect(s2).toBeCloseTo(s1 * 0.25, 6);
  });

  it("returns 0 when no edge", () => {
    const row = makeRow({
      softOdds: 1.9,
      sharpTrueProb: 0.5,
      softCommissionPct: 0,
    });
    expect(kellyStake(row, 1000)).toBe(0);
  });
});
