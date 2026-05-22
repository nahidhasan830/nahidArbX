import { describe, it, expect } from "vitest";
import {
  computeKellyMultiplier,
  computeModelEdgePct,
  computeScoredStake,
} from "@/lib/ml/staker";
import { FEATURE_COUNT, FEATURE_INDEX } from "@/lib/ml/feature-contract";

function makeFeatures(
  overrides: Partial<Record<number, number>> = {},
): number[] {
  const f = new Array(FEATURE_COUNT).fill(0);
  f[FEATURE_INDEX.sharp_true_prob] = 0.5;
  f[FEATURE_INDEX.soft_odds] = 2.15;
  f[FEATURE_INDEX.adjusted_soft_odds] = 2.15;
  f[FEATURE_INDEX.tick_count] = 5;
  f[FEATURE_INDEX.market_type_encoded] = 0;
  for (const [idx, val] of Object.entries(overrides)) {
    f[Number(idx)] = val;
  }
  return f;
}

const IDX_TICK_COUNT = FEATURE_INDEX.tick_count;
const IDX_STEAM_SHARP = FEATURE_INDEX.steam_move_sharp;
const IDX_CONVERGENCE = FEATURE_INDEX.convergence_rate;
const IDX_SHARP_TRUE_PROB = FEATURE_INDEX.sharp_true_prob;
const IDX_MARKET_TYPE = FEATURE_INDEX.market_type_encoded;

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
          makeFeatures({ [IDX_SHARP_TRUE_PROB]: 0.45 }),
          "gate_only",
        ),
      ).toBe(0);
      expect(
        computeKellyMultiplier(
          0.9,
          makeFeatures({ [IDX_MARKET_TYPE]: 7 }),
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
      const features = makeFeatures({
        [IDX_TICK_COUNT]: 20,
        [IDX_STEAM_SHARP]: 1,
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
      const features = makeFeatures({
        [IDX_TICK_COUNT]: 20,
        [IDX_STEAM_SHARP]: 1,
      });
      const m = computeKellyMultiplier(0.95, features, "stake_increase");
      expect(m!).toBeGreaterThan(1.0);
    });

    it("caps at 2.0", () => {
      const features = makeFeatures({
        [IDX_TICK_COUNT]: 20,
        [IDX_STEAM_SHARP]: 1,
      });
      const m = computeKellyMultiplier(1.0, features, "stake_increase");
      expect(m!).toBe(2.0);
    });
  });
});

describe("computeScoredStake", () => {
  it("returns null when no model (mlScore is null)", () => {
    expect(
      computeScoredStake(0.05, null, makeFeatures(), "observe"),
    ).toBeNull();
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
