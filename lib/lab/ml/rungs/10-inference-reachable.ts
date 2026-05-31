import type { RungDefinition } from "./types";

export const rung10InferenceReachable: RungDefinition = {
  id: "inference_reachable",
  number: 10,
  category: "inference",
  title: "Inference is available",
  prereqs: ["deployment_gate"],
  evaluate: (d) => {
    const inf = d.inference;

    if (!inf.modelLoaded) {
      return {
        status: "fail",
        primary: "offline",
        secondary: "live scoring is not available for the deployed model.",
        action: "Restart the engine after confirming a deployed model exists.",
      };
    }

    const attempts = inf.totalScoringAttempts ?? 0;
    const scored = inf.totalScored ?? 0;

    if (attempts === 0) {
      return {
        status: "pending",
        primary: "0 attempts",
        secondary: "live scoring is configured but no inference has run yet.",
      };
    }

    const successRate = (scored / attempts) * 100;
    if (successRate >= 95) {
      return {
        status: "pass",
        primary: `${scored.toLocaleString()} / ${attempts.toLocaleString()}`,
        secondary: `${successRate.toFixed(1)}% of inference attempts returned a calibrated score; avg ${inf.avgInferenceMs.toFixed(0)}ms.`,
      };
    }

    return {
      status: "warn",
      primary: `${successRate.toFixed(1)}% success`,
      secondary: "a meaningful fraction of inference attempts are failing.",
      action:
        "Check live scoring health and restart the engine if failures continue.",
    };
  },
  inputs: (d) => [
    { label: "modelLoaded", value: String(d.inference.modelLoaded) },
    {
      label: "modelVersion",
      value:
        d.inference.modelVersion == null
          ? "null"
          : `v${d.inference.modelVersion}`,
    },
    {
      label: "totalScoringAttempts",
      value: (d.inference.totalScoringAttempts ?? 0).toLocaleString(),
    },
    {
      label: "totalScored",
      value: (d.inference.totalScored ?? 0).toLocaleString(),
    },
    {
      label: "avgInferenceMs",
      value: `${d.inference.avgInferenceMs.toFixed(2)} ms`,
    },
  ],
  evidence: {
    why: "Without working inference the model exists but never affects a bet decision.",
  },
};
