import type { RungDefinition } from "./types";

export const rung05ColdStart: RungDefinition = {
  id: "cold_start",
  number: 5,
  category: "data",
  title: "Corpus is past cold-start",
  evaluate: (d) => {
    const have = d.dataCollection.qualifiedForTraining;
    const need = d.dataCollection.coldStartThreshold;

    if (have >= need) {
      const multiple = (have / need).toFixed(1);
      return {
        status: "pass",
        primary: `${have.toLocaleString()} / ${need}`,
        secondary: `${multiple}× past the cold-start threshold.`,
      };
    }

    const remaining = need - have;
    return {
      status: "fail",
      primary: `${have.toLocaleString()} / ${need}`,
      secondary: `${remaining.toLocaleString()} more training examples needed before the trainer will accept a run.`,
      action:
        "Wait for the next batch of settled bets — or check that settlement is actually applying outcomes.",
    };
  },
  inputs: (d) => [
    {
      label: "qualifiedForTraining",
      value: d.dataCollection.qualifiedForTraining.toLocaleString(),
    },
    {
      label: "coldStartThreshold",
      value: d.dataCollection.coldStartThreshold.toLocaleString(),
    },
    {
      label: "remainingToColdStart",
      value: d.dataCollection.currentCorpus.remainingToColdStart.toLocaleString(),
    },
    {
      label: "wins / losses",
      value: `${d.dataCollection.currentCorpus.wins.toLocaleString()} / ${d.dataCollection.currentCorpus.losses.toLocaleString()}`,
    },
  ],
  evidence: {
    assertion:
      "dataCollection.qualifiedForTraining ≥ dataCollection.coldStartThreshold",
    sourceFile: "lib/ml/training-sample-accounting.ts:160",
    why: "Below 200 the trainer rejects every run with `Cold start: N samples, need 200` and writes a `failed` row to ml_models.",
  },
};
