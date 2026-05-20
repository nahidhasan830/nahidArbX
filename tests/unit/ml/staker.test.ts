import { describe, it, expect } from "vitest";
import {
  computeKellyMultiplier,
  computeModelEdgePct,
  computeScoredStake,
} from "@/lib/ml/staker";

/**
 * Build a dummy 25-element feature vector.
 * Defaults: tick_count=5, convergence_rate=0, steam_move_sharp=0.
 * Override specific features by index.
 */
function makeFeatures(overrides: Record<number, number> = {}): number[] {
  const f = new Array(25).fill(0);
  // Set reasonable defaults for features used by the multiplier:
  // 0 = ev_pct, 2 = soft_odds, 3 = adjusted_soft_odds, 5 = tick_count,
  // 17 = market_type_encoded.
  f[0] = 4;
  f[2] = 2.15;
  f[3] = 2.15;
  f[5] = 5; // tick_count (below persistence bonus threshold)
  f[17] = 0; // MATCH_RESULT, part of the simple EV baseline cohort.
  for (const [idx, val] of Object.entries(overrides)) {
    f[Number(idx)] = val;
  }
  return f;
}

// Feature indices (from FEATURE_NAMES in features.ts)
const IDX_TICK_COUNT = 5;
const IDX_STEAM_SHARP = 9;
const IDX_CONVERGENCE = 13;

describe("computeKellyMultiplier", () => {
  it("returns null when mlScore is null (no model)", () => {
    expect(computeKellyMultiplier(null, makeFeatures(), "observe")).toBeNull();
    expect(
      computeKellyMultiplier(null, makeFeatures(), "stake_reduce"),
    ).toBeNull();
  });

  describe("observe permission", () => {
    it("always returns null regardless of score", () => {
      expect(computeKellyMultiplier(0.9, makeFeatures(), "observe")).toBeNull();
      expect(computeKellyMultiplier(0.1, makeFeatures(), "observe")).toBeNull();
    });
  });

  describe("gate_only permission", () => {
    it("returns 0 when model edge is not positive", () => {
      expect(computeKellyMultiplier(0.3, makeFeatures(), "gate_only")).toBe(0);
      expect(computeKellyMultiplier(0.46, makeFeatures(), "gate_only")).toBe(0);
    });

    it("returns 1.0 when model edge is positive", () => {
      expect(computeKellyMultiplier(0.47, makeFeatures(), "gate_only")).toBe(1);
      expect(computeKellyMultiplier(0.9, makeFeatures(), "gate_only")).toBe(1);
    });

    it("requires the simple EV baseline cohort before the model overlay", () => {
      expect(
        computeKellyMultiplier(
          0.9,
          makeFeatures({ 0: 1.5 }),
          "gate_only",
        ),
      ).toBe(0);
      expect(
        computeKellyMultiplier(
          0.9,
          makeFeatures({ 17: 7 }),
          "gate_only",
        ),
      ).toBe(0);
    });
  });

  describe("stake_reduce permission", () => {
    it("returns 0 when score is below threshold", () => {
      expect(computeKellyMultiplier(0.3, makeFeatures(), "stake_reduce")).toBe(
        0,
      );
    });

    it("returns a multiplier <= 1.0 (never increases)", () => {
      const m = computeKellyMultiplier(0.47, makeFeatures(), "stake_reduce");
      expect(m).not.toBeNull();
      expect(m!).toBeLessThanOrEqual(1.0);
      expect(m!).toBeGreaterThan(0);
    });

    it("caps at 1.0 even with high score and bonuses", () => {
      // High score + persistence + steam should exceed 1.0 raw
      const features = makeFeatures({
        [IDX_TICK_COUNT]: 20,
        [IDX_STEAM_SHARP]: 5,
      });
      const m = computeKellyMultiplier(0.95, features, "stake_reduce");
      expect(m).toBe(1.0);
    });

    it("applies convergence penalty to reduce multiplier further", () => {
      const noConvergence = computeKellyMultiplier(
        0.7,
        makeFeatures({ [IDX_CONVERGENCE]: 0 }),
        "stake_reduce",
      );
      const withConvergence = computeKellyMultiplier(
        0.7,
        makeFeatures({ [IDX_CONVERGENCE]: -0.5 }),
        "stake_reduce",
      );
      expect(withConvergence!).toBeLessThan(noConvergence!);
    });
  });

  describe("stake_increase permission", () => {
    it("returns 0 when score is below threshold", () => {
      expect(
        computeKellyMultiplier(0.3, makeFeatures(), "stake_increase"),
      ).toBe(0);
    });

    it("can return multiplier > 1.0 (allows increase)", () => {
      // High score with bonuses
      const features = makeFeatures({
        [IDX_TICK_COUNT]: 20,
        [IDX_STEAM_SHARP]: 5,
      });
      const m = computeKellyMultiplier(0.95, features, "stake_increase");
      expect(m!).toBeGreaterThan(1.0);
    });

    it("caps at 2.0", () => {
      // Maximum possible: score=1.0 → base=1.5, × 1.2 (tick) × 1.3 (steam) = 2.34
      // Should be capped at 2.0
      const features = makeFeatures({
        [IDX_TICK_COUNT]: 20,
        [IDX_STEAM_SHARP]: 5,
      });
      const m = computeKellyMultiplier(1.0, features, "stake_increase");
      expect(m!).toBe(2.0);
    });
  });
});

describe("computeScoredStake", () => {
  it("returns null when no model (mlScore is null)", () => {
    expect(computeScoredStake(0.05, null, makeFeatures(), "observe")).toBeNull();
  });

  it("returns null in observe mode", () => {
    expect(computeScoredStake(0.05, 0.8, makeFeatures(), "observe")).toBeNull();
  });

  it("returns 0 when gated", () => {
    expect(computeScoredStake(0.05, 0.3, makeFeatures(), "gate_only")).toBe(0);
  });

  it("returns baseKelly × multiplier for stake_reduce", () => {
    const baseKelly = 0.05;
    const features = makeFeatures();
    const multiplier = computeKellyMultiplier(0.7, features, "stake_reduce");
    const adjusted = computeScoredStake(0.05, 0.7, features, "stake_reduce");
    expect(adjusted).toBeCloseTo(baseKelly * multiplier!, 10);
  });

  it("manual placement is unaffected (observe returns null)", () => {
    const result = computeScoredStake(0.05, 0.9, makeFeatures(), "observe");
    expect(result).toBeNull();
  });
});

describe("computeModelEdgePct", () => {
  it("converts calibrated win probability into offered-odds EV", () => {
    expect(computeModelEdgePct(0.5, makeFeatures())).toBeCloseTo(7.5, 6);
    expect(computeModelEdgePct(0.4, makeFeatures())).toBeLessThan(0);
  });
});
