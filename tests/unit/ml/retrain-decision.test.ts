import { describe, expect, it } from "vitest";
import {
  decideRetrain,
  type RetrainDecisionInputs,
} from "@/lib/optimizer/scheduler";

const HASH_A = "a1b2c3d4";
const HASH_B = "deadbeef";

function baseInputs(
  overrides: Partial<RetrainDecisionInputs> = {},
): RetrainDecisionInputs {
  return {
    inTrainingCount: 0,
    totalAvailableSamples: 4821,
    coldStartThreshold: 200,
    growthStep: 200,
    currentFeatureNamesHash: HASH_A,
    deployedModel: null,
    lastTerminalNonDeployed: null,
    ...overrides,
  };
}

describe("decideRetrain", () => {
  it("blocks while a training run is in progress", () => {
    const d = decideRetrain(baseInputs({ inTrainingCount: 1 }));
    expect(d).toEqual({ should: false, reason: "training_in_progress" });
  });

  it("blocks below cold-start", () => {
    const d = decideRetrain(baseInputs({ totalAvailableSamples: 50 }));
    expect(d).toEqual({ should: false, reason: "below_cold_start" });
  });

  it("fires the first training when corpus crosses cold-start and no deployed exists", () => {
    const d = decideRetrain(baseInputs());
    expect(d).toEqual({ should: true, reason: "cold_start_first_train" });
  });

  it("fires when growth since deploy ≥ growthStep", () => {
    const d = decideRetrain(
      baseInputs({
        deployedModel: { trainingSamples: 4500 },
        totalAvailableSamples: 4750,
      }),
    );
    expect(d).toEqual({ should: true, reason: "growth_step_reached" });
  });

  it("blocks when growth since deploy < growthStep", () => {
    const d = decideRetrain(
      baseInputs({
        deployedModel: { trainingSamples: 4750 },
        totalAvailableSamples: 4800,
      }),
    );
    expect(d).toEqual({ should: false, reason: "growth_below_step" });
  });

  describe("identical-inputs guard", () => {
    it("blocks when last rejected run had the same samples + same feature hash", () => {
      const d = decideRetrain(
        baseInputs({
          lastTerminalNonDeployed: {
            status: "rejected",
            trainingSamples: 4821,
            featureNamesHash: HASH_A,
            rejectionReasons: ["AUC-ROC too low"],
          },
        }),
      );
      expect(d).toEqual({
        should: false,
        reason: "identical_inputs_would_repeat_outcome",
      });
    });

    it("allows retraining when feature hash changed (code change after rejection)", () => {
      const d = decideRetrain(
        baseInputs({
          lastTerminalNonDeployed: {
            status: "rejected",
            trainingSamples: 4821,
            featureNamesHash: HASH_B, // older hash
            rejectionReasons: ["AUC-ROC too low"],
          },
        }),
      );
      expect(d).toEqual({ should: true, reason: "cold_start_first_train" });
    });

    it("blocks when corpus grew only slightly since last rejection", () => {
      const d = decideRetrain(
        baseInputs({
          totalAvailableSamples: 4824,
          lastTerminalNonDeployed: {
            status: "rejected",
            trainingSamples: 4821,
            featureNamesHash: HASH_A,
            rejectionReasons: ["AUC-ROC too low"],
          },
        }),
      );
      expect(d).toEqual({
        should: false,
        reason: "terminal_growth_below_step",
      });
    });

    it("allows retraining when corpus grew by a full retrain step since last rejection", () => {
      const d = decideRetrain(
        baseInputs({
          totalAvailableSamples: 5021,
          lastTerminalNonDeployed: {
            status: "rejected",
            trainingSamples: 4821,
            featureNamesHash: HASH_A,
            rejectionReasons: ["AUC-ROC too low"],
          },
        }),
      );
      expect(d).toEqual({ should: true, reason: "cold_start_first_train" });
    });

    it("allows retraining when last terminal had a null featureNamesHash (legacy row)", () => {
      const d = decideRetrain(
        baseInputs({
          lastTerminalNonDeployed: {
            status: "rejected",
            trainingSamples: 4821,
            featureNamesHash: null,
            rejectionReasons: ["AUC-ROC too low"],
          },
        }),
      );
      // null !== HASH_A → guard does not fire → falls through to cold-start branch.
      expect(d).toEqual({ should: true, reason: "cold_start_first_train" });
    });

    it("guard takes priority over deployed-model growth check", () => {
      // Even when there's a deployed model and growth would normally fire,
      // a recent same-contract rejection should block until another full
      // retrain step has accumulated.
      const d = decideRetrain(
        baseInputs({
          deployedModel: { trainingSamples: 4500 },
          totalAvailableSamples: 4824,
          lastTerminalNonDeployed: {
            status: "rejected",
            trainingSamples: 4821,
            featureNamesHash: HASH_A,
            rejectionReasons: ["AUC-ROC too low"],
          },
        }),
      );
      expect(d).toEqual({
        should: false,
        reason: "terminal_growth_below_step",
      });
    });

    it("allows deployed-model growth check after terminal baseline also grew by a full step", () => {
      const d = decideRetrain(
        baseInputs({
          deployedModel: { trainingSamples: 4500 },
          totalAvailableSamples: 5021,
          lastTerminalNonDeployed: {
            status: "rejected",
            trainingSamples: 4821,
            featureNamesHash: HASH_A,
            rejectionReasons: ["AUC-ROC too low"],
          },
        }),
      );
      expect(d).toEqual({ should: true, reason: "growth_step_reached" });
    });

    it("does not block when only a deployed model exists (no terminal-non-deployed)", () => {
      const d = decideRetrain(
        baseInputs({
          deployedModel: { trainingSamples: 4500 },
          totalAvailableSamples: 4750,
          lastTerminalNonDeployed: null,
        }),
      );
      expect(d).toEqual({ should: true, reason: "growth_step_reached" });
    });

    it("blocks watchdog-marked launcher interruption on identical inputs", () => {
      const d = decideRetrain(
        baseInputs({
          lastTerminalNonDeployed: {
            status: "failed",
            trainingSamples: 4821,
            featureNamesHash: HASH_A,
            rejectionReasons: [
              "Training watchdog marked this run failed: no heartbeat since 2026-05-23T19:05:33.389Z (60m > 45m).",
            ],
          },
        }),
      );
      expect(d).toEqual({
        should: false,
        reason: "identical_inputs_would_repeat_outcome",
      });
    });

    it("still blocks non-retryable failed runs on identical inputs", () => {
      const d = decideRetrain(
        baseInputs({
          lastTerminalNonDeployed: {
            status: "failed",
            trainingSamples: 4821,
            featureNamesHash: HASH_A,
            rejectionReasons: ["Cloud Build + Run pipeline failed (exit code 1)"],
          },
        }),
      );
      expect(d).toEqual({
        should: false,
        reason: "identical_inputs_would_repeat_outcome",
      });
    });

    it("blocks Vertex label failures on identical inputs", () => {
      const d = decideRetrain(
        baseInputs({
          lastTerminalNonDeployed: {
            status: "failed",
            trainingSamples: 4821,
            featureNamesHash: HASH_A,
            rejectionReasons: [
              "Unexpected error in training pipeline: Field: model.labels; Message: Label values must be valid.",
            ],
          },
        }),
      );
      expect(d).toEqual({
        should: false,
        reason: "identical_inputs_would_repeat_outcome",
      });
    });
  });

  describe("priority ordering", () => {
    it("training_in_progress beats cold_start", () => {
      const d = decideRetrain(
        baseInputs({
          inTrainingCount: 1,
          totalAvailableSamples: 50,
        }),
      );
      expect(d.reason).toBe("training_in_progress");
    });

    it("below_cold_start beats identical_inputs", () => {
      const d = decideRetrain(
        baseInputs({
          totalAvailableSamples: 50,
          lastTerminalNonDeployed: {
            status: "rejected",
            trainingSamples: 50,
            featureNamesHash: HASH_A,
            rejectionReasons: ["AUC-ROC too low"],
          },
        }),
      );
      expect(d.reason).toBe("below_cold_start");
    });
  });
});
