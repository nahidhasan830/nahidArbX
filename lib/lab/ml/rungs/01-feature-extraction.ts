import type { RungDefinition } from "./types";

export const rung01FeatureExtraction: RungDefinition = {
  id: "feature_extraction",
  number: 1,
  category: "data",
  title: "Bets are arriving with features",
  evaluate: (d) => {
    const rate = d.dataCollection.recentFeatureRate;
    if (rate >= 80) {
      return {
        status: "pass",
        primary: `${rate}%`,
        secondary: "of the last 100 bets carry an ML feature vector.",
      };
    }
    if (rate >= 50) {
      return {
        status: "warn",
        primary: `${rate}%`,
        secondary:
          "feature extraction is lagging on a meaningful slice of recent bets.",
        action: "Check that the engine and both odds feeds are healthy.",
      };
    }
    return {
      status: "fail",
      primary: `${rate}%`,
      secondary:
        "most recent bets are missing an ML feature vector — training data is starving.",
      action: "Start or restart the engine, then refresh this page.",
    };
  },
  inputs: (d) => [
    {
      label: "recentFeatureRate",
      value: `${d.dataCollection.recentFeatureRate}%`,
    },
    {
      label: "totalBets",
      value: d.dataCollection.totalBets.toLocaleString(),
    },
    {
      label: "betsWithFeatures",
      value: d.dataCollection.betsWithFeatures.toLocaleString(),
    },
    {
      label: "settledWithFeatures",
      value: d.dataCollection.settledWithFeatures.toLocaleString(),
    },
  ],
  evidence: {
    why: "If features stop being attached to bets, the corpus stops growing and every downstream rung quietly drifts.",
  },
};
