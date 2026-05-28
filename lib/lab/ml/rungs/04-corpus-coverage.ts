import type { RungDefinition } from "./types";

export const rung04CorpusCoverage: RungDefinition = {
  id: "corpus_coverage",
  number: 4,
  category: "data",
  title: "Settled bets land in the training corpus",
  evaluate: (d) => {
    const uncovered = d.dataCollection.uncoveredQualifiedBets;
    const canonical = d.dataCollection.canonicalExamples;

    if (uncovered === 0) {
      return {
        status: "pass",
        primary: `${canonical.toLocaleString()} / ${canonical.toLocaleString()}`,
        secondary:
          "every qualified settled bet is covered by a canonical training example.",
      };
    }

    return {
      status: "warn",
      primary: `${uncovered.toLocaleString()} uncovered`,
      secondary:
        "qualified settled bets are not yet wired into the training corpus.",
      action: "Click Reconcile now to backfill missing settled examples.",
    };
  },
  inputs: (d) => [
    {
      label: "qualifiedForTraining",
      value: d.dataCollection.qualifiedForTraining.toLocaleString(),
    },
    {
      label: "canonicalExamples",
      value: d.dataCollection.canonicalExamples.toLocaleString(),
    },
    {
      label: "uncoveredQualifiedBets",
      value: d.dataCollection.uncoveredQualifiedBets.toLocaleString(),
    },
  ],
  evidence: {
    why: "Uncovered settled bets are eligible training data the loader can never see. They inflate qualifiedForTraining without adding to the actual training set.",
  },
  actions: [
    {
      id: "reconcile_now",
      label: "Reconcile now",
      description:
        "Backfill missing settled examples. Safe to retry.",
      method: "POST",
      endpoint: "/api/ml/reconcile",
      visibleWhen: (d) => d.dataCollection.uncoveredQualifiedBets > 0,
    },
  ],
};
