import type { RungDefinition } from "./types";

export const rung10InferenceReachable: RungDefinition = {
  id: "inference_reachable",
  number: 10,
  category: "inference",
  title: "Inference is reaching Vertex",
  prereqs: ["deployment_gate"],
  evaluate: (d) => {
    const inf = d.inference;

    if (!inf.modelLoaded) {
      return {
        status: "fail",
        primary: "endpoint missing",
        secondary: inf.error
          ? `engine reports: ${inf.error}.`
          : "no `VERTEX_PREDICTION_ENDPOINT` is configured.",
        action:
          "Set `VERTEX_PREDICTION_ENDPOINT` in `.env`, restart the engine, and re-check.",
      };
    }

    const attempts = inf.totalScoringAttempts ?? 0;
    const scored = inf.totalScored ?? 0;

    if (attempts === 0) {
      return {
        status: "pending",
        primary: "0 attempts",
        secondary: "endpoint configured but no inference has run yet.",
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
      secondary:
        "a meaningful fraction of inference attempts return null — endpoint is flaky or auth-broken.",
      action:
        "Check Vertex AI endpoint health, ADC credentials, and the engine logs for `VertexPredictionClient` warnings.",
    };
  },
  inputs: (d) => [
    { label: "modelLoaded", value: String(d.inference.modelLoaded) },
    {
      label: "modelVersion",
      value: d.inference.modelVersion == null ? "null" : `v${d.inference.modelVersion}`,
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
    {
      label: "error",
      value: d.inference.error ?? "null",
    },
  ],
  evidence: {
    assertion:
      "inference.modelLoaded && inference.totalScored / totalScoringAttempts ≥ 0.95",
    sourceFile: "lib/ml/scorer.ts:scoreBatch",
    why: "Without working inference the model exists but never affects a bet decision.",
  },
};
