import { describe, expect, it } from "vitest";

import {
  POLICY_EDGE_THRESHOLD_DENY_ALL_PCT,
  resolvePolicyEdgeThreshold,
} from "@/lib/ml/deployment-gate";

describe("resolvePolicyEdgeThreshold", () => {
  it("reads the learned threshold from artifact metadata", () => {
    expect(
      resolvePolicyEdgeThreshold({ policy_edge_threshold_pct: "8.5" }),
    ).toEqual({
      thresholdPct: 8.5,
      source: "artifact",
    });
  });

  it("fails closed for old artifacts without a learned threshold", () => {
    expect(resolvePolicyEdgeThreshold({}).thresholdPct).toBe(
      POLICY_EDGE_THRESHOLD_DENY_ALL_PCT,
    );
    expect(resolvePolicyEdgeThreshold({}).source).toBe("missing_artifact");
  });
});
