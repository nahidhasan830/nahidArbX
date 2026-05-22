import type { RungDefinition } from "./types";

export const rung03TierEnrichment: RungDefinition = {
  id: "tier_enrichment",
  number: 3,
  category: "data",
  title: "Competition tier enrichment is healthy",
  evaluate: (d) => {
    const h = d.featureContract.recentTierHealth;
    if (!h) {
      return {
        status: "pending",
        primary: "—",
        secondary: "tier-health metric not yet exposed by the engine.",
      };
    }

    if (h.betsWithFeatures === 0) {
      return {
        status: "pending",
        primary: "—",
        secondary: `no bets in the last ${h.windowHours}h to verify enrichment cache health.`,
      };
    }

    if (h.healthy) {
      return {
        status: "pass",
        primary: `${h.validTierPct?.toFixed(1)}%`,
        secondary: `of the ${h.betsWithFeatures.toLocaleString()} bets in the last ${h.windowHours}h carry a valid tier (1, 2, or 3).`,
      };
    }

    return {
      status: "fail",
      primary: `${h.validTierPct?.toFixed(1)}%`,
      secondary:
        "the enrichment cache is mis-classifying recent bets — model can't see them at training or inference time.",
      action:
        "Restart the competition-enrichment warmer in the engine and check the AI tier classifier for rate-limits or quota exhaustion.",
    };
  },
  inputs: (d) => {
    const h = d.featureContract.recentTierHealth;
    if (!h) return [{ label: "recentTierHealth", value: "not exposed" }];
    return [
      { label: "windowHours", value: String(h.windowHours) },
      { label: "betsWithFeatures", value: h.betsWithFeatures.toLocaleString() },
      { label: "betsWithValidTier", value: h.betsWithValidTier.toLocaleString() },
      {
        label: "validTierPct",
        value: h.validTierPct == null ? "n/a" : `${h.validTierPct.toFixed(2)}%`,
      },
      { label: "healthy", value: String(h.healthy) },
    ];
  },
  evidence: {
    assertion: "featureContract.recentTierHealth.healthy === true",
    sourceFile: "app/api/ml/pipeline/route.ts:208",
    why: "Every loader filter excludes bets whose competition_tier ∉ {1, 2, 3}. A broken enrichment warmer silently shrinks the trainable corpus to zero.",
    sql: `SELECT
  count(*) FILTER (
    WHERE first_seen_at >= now() - interval '24 hours'
      AND ml_features IS NOT NULL
      AND ml_features[19] IN (1.0, 2.0, 3.0)
  )::float
  / nullif(
      count(*) FILTER (
        WHERE first_seen_at >= now() - interval '24 hours'
          AND ml_features IS NOT NULL
      ), 0
    ) * 100 AS valid_tier_pct
FROM bets;`,
  },
};
