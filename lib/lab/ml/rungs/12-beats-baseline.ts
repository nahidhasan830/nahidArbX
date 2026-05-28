import type { RungDefinition } from "./types";

export const rung12BeatsBaseline: RungDefinition = {
  id: "beats_baseline",
  number: 12,
  category: "quality",
  title: "ML beats the simple-EV rule on paper",
  prereqs: ["inference_reachable"],
  evaluate: (d) => {
    const v = d.paperEvaluation.verdict;
    const m = d.paperEvaluation.metrics;
    const delta = v.mlMinusSimpleRoiPct;

    if (!v.enoughMlGateSamples) {
      const have = m.mlGate.sampleSize;
      return {
        status: "pending",
        primary: `${have.toLocaleString()} / 100`,
        secondary:
          "not enough ML-gate samples yet to compare against the simple-EV rule.",
      };
    }

    if (v.mlBeatsSimpleRule && delta != null) {
      return {
        status: "pass",
        primary: `+${delta.toFixed(2)}pp ROI`,
        secondary: `ML gate (${m.mlGate.roiPct?.toFixed(2) ?? "—"}% ROI on ${m.mlGate.sampleSize}) beats simple EV (${m.simpleEvCore.roiPct?.toFixed(2) ?? "—"}% on ${m.simpleEvCore.sampleSize}).`,
      };
    }

    return {
      status: "warn",
      primary: delta != null ? `${delta.toFixed(2)}pp ROI` : "—",
      secondary:
        "ML gate isn't beating the non-ML baseline rule. Don't promote past observe.",
      action:
        "Hold the current model at observe-only. Retrain after the corpus grows or fix features.",
    };
  },
  inputs: (d) => {
    const m = d.paperEvaluation.metrics;
    return [
      {
        label: "detectedBaseline",
        value: `n=${m.detectedBaseline.sampleSize}, ROI=${m.detectedBaseline.roiPct?.toFixed(2) ?? "—"}%`,
      },
      {
        label: "simpleEvCore",
        value: `n=${m.simpleEvCore.sampleSize}, ROI=${m.simpleEvCore.roiPct?.toFixed(2) ?? "—"}%`,
      },
      {
        label: "mlScored",
        value: `n=${m.mlScored.sampleSize}, ROI=${m.mlScored.roiPct?.toFixed(2) ?? "—"}%`,
      },
      {
        label: "mlGate",
        value: `n=${m.mlGate.sampleSize}, ROI=${m.mlGate.roiPct?.toFixed(2) ?? "—"}%`,
      },
      {
        label: "mlMinusSimpleRoiPct",
        value:
          d.paperEvaluation.verdict.mlMinusSimpleRoiPct == null
            ? "n/a"
            : `${d.paperEvaluation.verdict.mlMinusSimpleRoiPct.toFixed(2)}pp`,
      },
      {
        label: "policyEdgeThreshold",
        value: `${d.paperEvaluation.mlModelEdgeThresholdPct.toFixed(2)}%`,
      },
    ];
  },
  evidence: {
    why: "If the model can't beat the simple EV baseline, the ML stack is paying its operational cost without earning it.",
  },
};
