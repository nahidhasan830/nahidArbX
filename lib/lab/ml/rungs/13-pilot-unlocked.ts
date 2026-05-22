import type { RungDefinition } from "./types";

export const rung13PilotUnlocked: RungDefinition = {
  id: "pilot_unlocked",
  number: 13,
  category: "quality",
  title: "Pilot has unlocked stake_increase",
  prereqs: ["beats_baseline"],
  evaluate: (d) => {
    const level = d.deploymentGate.permissionLevel;

    if (level === "stake_increase") {
      return {
        status: "pass",
        primary: "stake_increase",
        secondary:
          "the live pilot promoted the deployed model to full Kelly sizing.",
      };
    }

    if (level === "stake_reduce") {
      return {
        status: "pending",
        primary: "stake_reduce",
        secondary:
          "model can shrink stake on weak bets but not grow it. The pilot needs more placed-settled evidence to promote.",
      };
    }

    if (level === "gate_only") {
      return {
        status: "pending",
        primary: "gate_only",
        secondary:
          "model can skip negative-EV bets but not affect stake size. Promotion to stake_reduce needs more evidence.",
      };
    }

    return {
      status: "pending",
      primary: level ?? "observe",
      secondary:
        "model is observe-only. The deployment gate hasn't seen enough evidence to grant active permissions.",
    };
  },
  inputs: (d) => [
    { label: "permissionLevel", value: d.deploymentGate.permissionLevel },
    {
      label: "policyEdgeThresholdPct",
      value: `${d.deploymentGate.policyEdgeThresholdPct.toFixed(2)}%`,
    },
    {
      label: "canGate",
      value: String(d.deploymentGate.canGate),
    },
    {
      label: "canReduceStake",
      value: String(d.deploymentGate.canReduceStake),
    },
    {
      label: "canIncreaseStake",
      value: String(d.deploymentGate.canIncreaseStake),
    },
  ],
  evidence: {
    assertion: "deploymentGate.permissionLevel === 'stake_increase'",
    sourceFile: "lib/optimizer/scheduler.ts:evaluatePilot",
    why: "stake_increase is the terminal state of the pipeline — full ML-driven sizing on real money. It only unlocks after a successful pilot A/B test.",
  },
};
