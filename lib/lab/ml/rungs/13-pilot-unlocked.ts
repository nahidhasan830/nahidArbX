import type { RungDefinition } from "./types";
import { formatPermissionLevel } from "../display";

export const rung13PilotUnlocked: RungDefinition = {
  id: "pilot_unlocked",
  number: 13,
  category: "quality",
  title: "Pilot has unlocked stake increases",
  prereqs: ["beats_baseline"],
  evaluate: (d) => {
    const level = d.deploymentGate.permissionLevel;

    if (level === "stake_increase") {
      return {
        status: "pass",
        primary: formatPermissionLevel("stake_increase"),
        secondary:
          "the live pilot promoted the deployed model to full Kelly sizing.",
      };
    }

    if (level === "stake_reduce") {
      return {
        status: "pending",
        primary: formatPermissionLevel("stake_reduce"),
        secondary:
          "model can shrink stake on weak bets but not grow it. The pilot needs more placed-settled evidence to promote.",
      };
    }

    if (level === "gate_only") {
      return {
        status: "pending",
        primary: formatPermissionLevel("gate_only"),
        secondary:
          "model can skip negative-EV bets but not affect stake size. Promotion to stake_reduce needs more evidence.",
      };
    }

    return {
      status: "pending",
      primary: formatPermissionLevel(level ?? "observe"),
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
    why: "Stake increases are the terminal state of the pipeline: full ML-driven sizing on real money. They only unlock after a successful pilot A/B test.",
  },
};
