import { afterEach, describe, expect, it, vi } from "vitest";
import { FEATURE_COUNT, FEATURE_INDEX } from "@/lib/ml/feature-contract";

function makeFeatures(): number[] {
  const f = new Array(FEATURE_COUNT).fill(0);
  // Sharp prob is high enough that the staker's sharp-cap does not reduce the
  // model probabilities used below — this test isolates the learned-threshold
  // logic, not the cap (see staker.test.ts for cap coverage).
  f[FEATURE_INDEX.sharp_true_prob] = 0.6;
  f[FEATURE_INDEX.soft_odds] = 2.15;
  f[FEATURE_INDEX.adjusted_soft_odds] = 2.15;
  f[FEATURE_INDEX.tick_count] = 5;
  f[FEATURE_INDEX.market_type_encoded] = 0;
  return f;
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/ml/deployment-gate");
});

describe("ML staker learned edge threshold", () => {
  it("uses the exported threshold instead of break-even edge", async () => {
    vi.resetModules();
    vi.doMock("@/lib/ml/deployment-gate", () => ({
      getPolicyEdgeThresholdPct: () => 10,
    }));

    const { computeKellyMultiplier, computeModelEdgePct } =
      await import("@/lib/ml/staker");
    const features = makeFeatures();

    expect(computeModelEdgePct(0.5, features)).toBeCloseTo(7.5, 6);
    expect(computeKellyMultiplier(0.5, features, "gate_only")).toBe(0);
    expect(computeKellyMultiplier(0.56, features, "gate_only")).toBe(1);
  });
});
