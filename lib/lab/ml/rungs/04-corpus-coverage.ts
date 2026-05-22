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
      action:
        "Click Reconcile to run `reconcileMissingSettledExamples(500)` immediately, or trigger any retrain.",
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
    assertion: "dataCollection.uncoveredQualifiedBets === 0",
    sourceFile: "lib/ml/training-sample-accounting.ts:88",
    why: "Uncovered settled bets are eligible training data the loader can never see. They inflate qualifiedForTraining without adding to the actual training set.",
    sql: `SELECT
  count(*)::int AS uncovered
FROM bets q
WHERE q.outcome NOT IN ('pending', 'void')
  AND q.ml_features IS NOT NULL
  AND q.ml_feature_version = 1
  AND NOT EXISTS (
    SELECT 1 FROM ml_training_examples m
    WHERE m.source_bet_id = q.id
      AND m.label IN ('positive', 'negative')
      AND m.feature_version = 1
  );`,
  },
  actions: [
    {
      id: "reconcile_now",
      kind: "mutation",
      label: "Reconcile now",
      description:
        "Run reconcileMissingSettledExamples(500) — idempotent, safe to retry.",
      method: "POST",
      endpoint: "/api/ml/reconcile",
      visibleWhen: (d) => d.dataCollection.uncoveredQualifiedBets > 0,
    },
  ],
};
