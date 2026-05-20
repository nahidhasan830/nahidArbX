import { afterEach, describe, expect, it, vi } from "vitest";

function makeFeatures(): number[] {
  const f = new Array(25).fill(0);
  f[0] = 4;
  f[2] = 2.15;
  f[3] = 2.15;
  f[5] = 5;
  f[17] = 0;
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

    const { computeKellyMultiplier, computeModelEdgePct } = await import(
      "@/lib/ml/staker"
    );
    const features = makeFeatures();

    expect(computeModelEdgePct(0.5, features)).toBeCloseTo(7.5, 6);
    expect(computeKellyMultiplier(0.5, features, "gate_only")).toBe(0);
    expect(computeKellyMultiplier(0.56, features, "gate_only")).toBe(1);
  });
});
