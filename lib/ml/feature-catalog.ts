/**
 * ML Feature Catalog — shared metadata for the 22-dimension feature vector.
 *
 * Used by the ML Optimizer dashboard and the feature inspection surfaces in
 * bets history. The order must match FEATURE_NAMES exactly.
 */

import { FEATURE_NAMES } from "./feature-contract";

export type FeatureCategory = "Value" | "Odds" | "Movement" | "Market";

export interface FeatureMeta {
  name: string;
  label: string;
  desc: string;
  cat: FeatureCategory;
  fmt: "pct" | "odds" | "ms" | "int" | "float" | "binary" | "dir";
}

export const CATEGORY_COLORS: Record<FeatureCategory, string> = {
  Value: "bg-emerald-400",
  Odds: "bg-cyan-400",
  Movement: "bg-violet-400",
  Market: "bg-amber-400",
};

export const CATEGORY_TEXT_COLORS: Record<FeatureCategory, string> = {
  Value: "text-emerald-400",
  Odds: "text-cyan-400",
  Movement: "text-violet-400",
  Market: "text-amber-400",
};

export const FEATURE_CATEGORIES = Object.keys(
  CATEGORY_COLORS,
) as FeatureCategory[];

const featureCatalog: FeatureMeta[] = [
  {
    name: "sharp_true_prob",
    label: "Sharp True Prob",
    desc: "True probability derived from the sharp line after removing vig.",
    cat: "Value",
    fmt: "pct",
  },
  {
    name: "soft_odds",
    label: "Soft Odds",
    desc: "Raw decimal odds from the soft bookmaker at detection time.",
    cat: "Odds",
    fmt: "odds",
  },
  {
    name: "adjusted_soft_odds",
    label: "Adjusted Soft Odds",
    desc: "Soft odds adjusted for commission so they reflect the payout you actually receive.",
    cat: "Odds",
    fmt: "odds",
  },
  {
    name: "tick_count",
    label: "Tick Count",
    desc: "Number of sharp-market odds updates recorded for this atom.",
    cat: "Movement",
    fmt: "int",
  },
  {
    name: "time_to_kickoff_min",
    label: "Time to Kickoff",
    desc: "Minutes until the event starts.",
    cat: "Market",
    fmt: "int",
  },
  {
    name: "movement_pct_sharp",
    label: "Sharp Movement %",
    desc: "Percentage change in the sharp odds from opening to current.",
    cat: "Movement",
    fmt: "pct",
  },
  {
    name: "movement_pct_soft",
    label: "Soft Movement %",
    desc: "Percentage change in the soft odds from opening to current.",
    cat: "Movement",
    fmt: "pct",
  },
  {
    name: "steam_move_sharp",
    label: "Sharp Steam",
    desc: "Whether the sharp market made a sudden move that qualifies as steam.",
    cat: "Movement",
    fmt: "binary",
  },
  {
    name: "steam_move_soft",
    label: "Soft Steam",
    desc: "Whether the soft market made a sudden move that qualifies as steam.",
    cat: "Movement",
    fmt: "binary",
  },
  {
    name: "sharp_direction",
    label: "Sharp Direction",
    desc: "Direction of the recent sharp move: up, down, or stable.",
    cat: "Movement",
    fmt: "dir",
  },
  {
    name: "soft_direction",
    label: "Soft Direction",
    desc: "Direction of the recent soft move: up, down, or stable.",
    cat: "Movement",
    fmt: "dir",
  },
  {
    name: "convergence_rate",
    label: "Convergence Rate",
    desc: "How quickly the soft odds are moving toward or away from the sharp odds.",
    cat: "Movement",
    fmt: "float",
  },
  {
    name: "tick_velocity",
    label: "Tick Velocity",
    desc: "Rate of soft-market updates per minute.",
    cat: "Movement",
    fmt: "float",
  },
  {
    name: "provider_count",
    label: "Provider Count",
    desc: "Number of providers currently offering odds on this atom.",
    cat: "Market",
    fmt: "int",
  },
  {
    name: "opening_sharp_odds",
    label: "Opening Sharp Odds",
    desc: "Earliest recorded sharp odds for this atom.",
    cat: "Odds",
    fmt: "odds",
  },
  {
    name: "market_type_encoded",
    label: "Market Type",
    desc: "Ordinal encoding of the market type used by the model.",
    cat: "Market",
    fmt: "int",
  },
  {
    name: "is_asian_line",
    label: "Is Asian Line",
    desc: "Whether the market uses a quarter-ball Asian line such as -0.25 or +0.75.",
    cat: "Market",
    fmt: "binary",
  },
  {
    name: "vig_pct",
    label: "Vig %",
    desc: "Sharp-market vigorish used when deriving fair probability.",
    cat: "Value",
    fmt: "pct",
  },
  {
    name: "competition_tier",
    label: "Competition Tier",
    desc: "Competition efficiency tier used as market context.",
    cat: "Market",
    fmt: "int",
  },
  {
    name: "hours_since_line_opened",
    label: "Hours Since Open",
    desc: "Hours since the sharp line first appeared in history.",
    cat: "Movement",
    fmt: "float",
  },
  {
    name: "sharp_soft_spread",
    label: "Sharp/Soft Spread",
    desc: "Difference between the soft odds and the sharp-derived fair odds.",
    cat: "Value",
    fmt: "odds",
  },
  {
    name: "num_markets_same_event",
    label: "Event Market Count",
    desc: "Number of active matched markets currently available on the same event.",
    cat: "Market",
    fmt: "int",
  },
];

const catalogNames = featureCatalog.map((feature) => feature.name);
if (
  catalogNames.length !== FEATURE_NAMES.length ||
  catalogNames.some((name, index) => name !== FEATURE_NAMES[index])
) {
  throw new Error(
    `FEATURE_CATALOG order mismatch. Expected ${FEATURE_NAMES.join(", ")}; got ${catalogNames.join(", ")}`,
  );
}

export const FEATURE_CATALOG = featureCatalog;

export function formatFeatureValue(
  value: number,
  fmt: FeatureMeta["fmt"],
): string {
  switch (fmt) {
    case "pct":
      return `${value.toFixed(2)}%`;
    case "odds":
      return value.toFixed(4);
    case "ms":
      if (Math.abs(value) < 1000) return `${Math.round(value)}ms`;
      return `${(value / 1000).toFixed(1)}s`;
    case "int":
      return Math.round(value).toString();
    case "float":
      return value.toFixed(4);
    case "binary":
      return value >= 0.5 ? "Yes (1)" : "No (0)";
    case "dir":
      if (value > 0.5) return "↑ Up (+1)";
      if (value < -0.5) return "↓ Down (-1)";
      return "— Stable (0)";
    default:
      return value.toFixed(4);
  }
}
