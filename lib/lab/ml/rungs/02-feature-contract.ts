import type { RungDefinition } from "./types";

export const rung02FeatureContract: RungDefinition = {
  id: "feature_contract",
  number: 2,
  category: "data",
  title: "Feature contract is uniform",
  evaluate: (d) => {
    const fc = d.featureContract;
    const sc = fc.semanticChecks;
    const totalCurrent = sc.betsWithCurrentFeatures;

    if (
      fc.allVersionsMatch &&
      fc.allLengthsMatch &&
      fc.allSemanticChecksPass
    ) {
      return {
        status: "pass",
        primary: `${totalCurrent.toLocaleString()} bets`,
        secondary: `all at v=${fc.currentVersion}, count=${fc.currentFeatureCount}, hash=${fc.currentNamesHash}.`,
      };
    }

    if (!fc.allVersionsMatch || !fc.allLengthsMatch) {
      const stale = fc.versionDistribution.filter(
        (v) => v.version !== fc.currentVersion,
      );
      const staleCount = stale.reduce((sum, v) => sum + v.count, 0);
      return {
        status: "warn",
        primary: `${staleCount.toLocaleString()} stale`,
        secondary:
          "older feature contracts present in the bets table — loaders skip them but the dashboard reports it.",
        action:
          "Run `scripts/run-ml-residual-cleanup.ts` to drop fv≠1 rows from the bets table.",
      };
    }

    return {
      status: "fail",
      primary: "semantic mismatch",
      secondary:
        "some current-version vectors carry an out-of-range competition tier.",
      action:
        "Inspect featureContract.semanticChecks; the enrichment cache may be writing tiers outside {1, 2, 3}.",
    };
  },
  inputs: (d) => {
    const fc = d.featureContract;
    return [
      { label: "currentVersion", value: String(fc.currentVersion) },
      { label: "currentFeatureCount", value: String(fc.currentFeatureCount) },
      { label: "currentNamesHash", value: fc.currentNamesHash },
      {
        label: "versionDistribution",
        value: fc.versionDistribution
          .map((v) => `v=${v.version ?? "null"}: ${v.count}`)
          .join(", "),
      },
      {
        label: "lengthDistribution",
        value: fc.lengthDistribution
          .map((l) => `len=${l.length ?? "null"}: ${l.count}`)
          .join(", "),
      },
      {
        label: "allVersionsMatch",
        value: String(fc.allVersionsMatch),
      },
      {
        label: "allLengthsMatch",
        value: String(fc.allLengthsMatch),
      },
      {
        label: "allSemanticChecksPass",
        value: String(fc.allSemanticChecksPass),
      },
      {
        label: "badCompetitionTier",
        value: String(fc.semanticChecks.badCompetitionTier),
      },
    ];
  },
  evidence: {
    assertion:
      "featureContract.allVersionsMatch && allLengthsMatch && allSemanticChecksPass",
    sourceFile: "app/api/ml/pipeline/route.ts:323",
    why: "Mixed feature contracts poison every loader query; the trainer hard-fails before training even starts.",
    sql: `SELECT
  ml_feature_version AS version,
  array_length(ml_features, 1) AS length,
  count(*)::int AS n
FROM bets
WHERE ml_features IS NOT NULL
GROUP BY version, length;`,
  },
  actions: [
    {
      id: "residual_cleanup_instruction",
      kind: "instruction",
      label: "Show cleanup command",
      description:
        "Remove residual fv≠1 rows from ml_models, ml_training_examples, and bets.ml_features.",
      command:
        "node --import tsx scripts/run-ml-residual-cleanup.ts",
      visibleWhen: (d) =>
        !d.featureContract.allVersionsMatch ||
        !d.featureContract.allLengthsMatch,
    },
  ],
};
