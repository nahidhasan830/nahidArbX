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
        secondary: "all active feature vectors use the current contract.",
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
        action: "Rebuild the stale feature vectors before the next training run.",
      };
    }

    return {
      status: "fail",
      primary: "semantic mismatch",
      secondary:
        "some current-version vectors carry an out-of-range competition tier.",
      action:
        "Refresh competition enrichment and wait for new clean feature vectors.",
    };
  },
  inputs: (d) => {
    const fc = d.featureContract;
    return [
      { label: "currentVersion", value: String(fc.currentVersion) },
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
    why: "Mixed feature contracts poison every loader query; the trainer hard-fails before training even starts.",
  },
};
