import { describe, it, expect } from "vitest";
import { deriveEdge, computeStake } from "@/lib/betting/sizing";

describe("deriveEdge", () => {
  it("computes positive EV when soft odds > fair price", () => {
    const result = deriveEdge({
      softOdds: 2.1,
      softCommissionPct: 0,
      sharpTrueProb: 0.5,
    });
    expect(result.evPct).toBeGreaterThan(0);
    expect(result.evPct).toBeCloseTo(5.0, 1); // 2.1 * 0.5 - 1 = 0.05
    expect(result.fullKelly).toBeGreaterThan(0);
  });

  it("computes zero EV at breakeven odds", () => {
    const result = deriveEdge({
      softOdds: 2.0,
      softCommissionPct: 0,
      sharpTrueProb: 0.5,
    });
    expect(result.evPct).toBeCloseTo(0, 5);
  });

  it("computes negative EV when soft odds < fair price", () => {
    const result = deriveEdge({
      softOdds: 1.9,
      softCommissionPct: 0,
      sharpTrueProb: 0.5,
    });
    expect(result.evPct).toBeLessThan(0);
    expect(result.fullKelly).toBeLessThan(0); // raw Kelly, floored at 0 only inside computeStake
  });

  it("applies commission to adjusted odds", () => {
    const noComm = deriveEdge({
      softOdds: 2.1,
      softCommissionPct: 0,
      sharpTrueProb: 0.5,
    });
    const withComm = deriveEdge({
      softOdds: 2.1,
      softCommissionPct: 5,
      sharpTrueProb: 0.5,
    });
    expect(withComm.adjustedOdds).toBeLessThan(noComm.adjustedOdds);
    expect(withComm.evPct).toBeLessThan(noComm.evPct);
  });

  it("returns fullKelly = 0 when b <= 0 (odds at 1 or below)", () => {
    const result = deriveEdge({
      softOdds: 1.0,
      softCommissionPct: 0,
      sharpTrueProb: 0.5,
    });
    expect(result.fullKelly).toBe(0);
  });

  it("Kelly fraction formula: (b*p - q) / b", () => {
    const prob = 0.6;
    const odds = 2.0;
    const b = odds - 1; // 1
    const expectedKelly = (b * prob - (1 - prob)) / b; // (0.6 - 0.4) / 1 = 0.2
    const result = deriveEdge({
      softOdds: odds,
      softCommissionPct: 0,
      sharpTrueProb: prob,
    });
    expect(result.fullKelly).toBeCloseTo(expectedKelly, 6);
  });
});

describe("computeStake", () => {
  it("quarter-Kelly of bankroll", () => {
    const stake = computeStake({
      fullKelly: 0.2,
      bankrollBdt: 1000,
      kellyCapPct: 10,
    });
    // 0.2 * 0.25 * 1000 = 50; cap = 1000 * 10/100 = 100; min(50, 100) = 50
    expect(stake).toBeCloseTo(50, 6);
  });

  it("caps at kellyCapPct of bankroll", () => {
    const stake = computeStake({
      fullKelly: 1.0, // 100% Kelly
      bankrollBdt: 1000,
      kellyCapPct: 5,
    });
    // 1.0 * 0.25 * 1000 = 250; cap = 1000 * 5/100 = 50; min(250, 50) = 50
    expect(stake).toBeCloseTo(50, 6);
  });

  it("floors negative Kelly at zero", () => {
    const stake = computeStake({
      fullKelly: -0.5,
      bankrollBdt: 1000,
      kellyCapPct: 10,
    });
    expect(stake).toBe(0);
  });

  it("returns zero for zero Kelly", () => {
    const stake = computeStake({
      fullKelly: 0,
      bankrollBdt: 1000,
      kellyCapPct: 10,
    });
    expect(stake).toBe(0);
  });

  it("scales linearly with bankroll", () => {
    const s1 = computeStake({
      fullKelly: 0.1,
      bankrollBdt: 1000,
      kellyCapPct: 20,
    });
    const s2 = computeStake({
      fullKelly: 0.1,
      bankrollBdt: 2000,
      kellyCapPct: 20,
    });
    expect(s2).toBeCloseTo(s1 * 2, 6);
  });
});
