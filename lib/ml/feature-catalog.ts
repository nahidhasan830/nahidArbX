/**
 * ML Feature Catalog — shared metadata for the 23-dimension feature vector.
 *
 * Used by both the Bet Optimizer dashboard (Pipeline Steps → Data Collection)
 * and the Feature Inspector dialog (Bets History table).
 *
 * Each entry maps to one dimension in the feature vector produced by
 * `extractFeatures()` in `lib/ml/features.ts`. The order here matches
 * `FEATURE_NAMES` in that file.
 */

export type FeatureCategory = "Value" | "Odds" | "Movement" | "Market" | "Staking";

export interface FeatureMeta {
  /** Internal feature name (matches Python training pipeline). */
  name: string;
  /** Human-readable short label. */
  label: string;
  /** One-sentence description for tooltips / inspector. */
  desc: string;
  /** Grouping category. */
  cat: FeatureCategory;
  /** Display format hint: how to render the numeric value. */
  fmt: "pct" | "odds" | "ms" | "int" | "float" | "binary" | "dir";
}

export const CATEGORY_COLORS: Record<FeatureCategory, string> = {
  Value: "bg-emerald-400",
  Odds: "bg-cyan-400",
  Movement: "bg-violet-400",
  Market: "bg-amber-400",
  Staking: "bg-rose-400",
};

export const CATEGORY_TEXT_COLORS: Record<FeatureCategory, string> = {
  Value: "text-emerald-400",
  Odds: "text-cyan-400",
  Movement: "text-violet-400",
  Market: "text-amber-400",
  Staking: "text-rose-400",
};

export const FEATURE_CATALOG: FeatureMeta[] = [
  { name: "ev_pct",            label: "EV %",              desc: "Expected value percentage — how much edge this bet has over the soft bookmaker's implied probability.", cat: "Value",    fmt: "pct" },
  { name: "sharp_true_prob",   label: "Sharp True Prob",   desc: "True probability derived from the sharp (Pinnacle) line after removing vig.", cat: "Value",    fmt: "pct" },
  { name: "soft_odds",         label: "Soft Odds",         desc: "Raw decimal odds from the soft bookmaker at detection time.", cat: "Odds",     fmt: "odds" },
  { name: "adjusted_soft_odds",label: "Adjusted Soft Odds",desc: "Soft odds adjusted for commission — the effective odds you actually receive.", cat: "Odds",     fmt: "odds" },
  { name: "implied_prob_gap",  label: "Implied Prob Gap",  desc: "Difference between sharp true probability and the soft book's implied probability. Larger gap = more value.", cat: "Value",    fmt: "pct" },
  { name: "soft_odds_age_ms",  label: "Odds Freshness",    desc: "Milliseconds since the soft odds were last updated. Stale odds are riskier.", cat: "Odds",     fmt: "ms" },
  { name: "tick_count",        label: "Tick Count",        desc: "Number of odds updates (ticks) recorded for the sharp line. More ticks = more liquid market.", cat: "Movement", fmt: "int" },
  { name: "time_to_kickoff_min",label: "Time to Kickoff",  desc: "Minutes until match start. Odds behaviour changes dramatically close to kickoff.", cat: "Market",   fmt: "int" },
  { name: "movement_pct_sharp",label: "Sharp Movement %",  desc: "Percentage change in sharp odds from opening to current. Indicates how much the sharp line has drifted.", cat: "Movement", fmt: "pct" },
  { name: "movement_pct_soft", label: "Soft Movement %",   desc: "Percentage change in soft odds from opening to current.", cat: "Movement", fmt: "pct" },
  { name: "steam_move_sharp",  label: "Steam Move (Sharp)",desc: "Binary: detected a sudden sharp odds movement (steam move) — often indicates insider or syndicate action.", cat: "Movement", fmt: "binary" },
  { name: "steam_move_soft",   label: "Steam Move (Soft)", desc: "Binary: detected a sudden soft odds movement — the soft book is reacting to market pressure.", cat: "Movement", fmt: "binary" },
  { name: "sharp_direction",   label: "Sharp Direction",   desc: "Direction of recent sharp line movement: +1 (drifting up), -1 (shortening), 0 (stable).", cat: "Movement", fmt: "dir" },
  { name: "soft_direction",    label: "Soft Direction",    desc: "Direction of recent soft line movement: +1 (drifting up), -1 (shortening), 0 (stable).", cat: "Movement", fmt: "dir" },
  { name: "convergence_rate",  label: "Convergence Rate",  desc: "OLS regression slope measuring how fast soft odds are converging toward sharp odds. Positive = gap closing.", cat: "Movement", fmt: "float" },
  { name: "tick_velocity",     label: "Tick Velocity",     desc: "Rate of odds updates per minute. High velocity indicates active trading / line movement.", cat: "Movement", fmt: "float" },
  { name: "provider_count",    label: "Provider Count",    desc: "Number of bookmakers currently offering odds on this market. More providers = better price discovery.", cat: "Market",   fmt: "int" },
  { name: "opening_sharp_odds",label: "Opening Sharp Odds",desc: "The earliest recorded sharp odds for this market — measures how much the line has moved since open.", cat: "Odds",     fmt: "odds" },
  { name: "market_type_encoded",label: "Market Type",      desc: "Ordinal encoding of the market (Match Result=0, Total Goals=1, Asian Handicap=2, etc.).", cat: "Market",   fmt: "int" },
  { name: "is_asian_line",     label: "Is Asian Line",     desc: "Binary: whether this is a quarter-ball Asian line (e.g. -0.25, +0.75). These have different dynamics.", cat: "Market",   fmt: "binary" },
  { name: "commission_pct",    label: "Commission %",      desc: "The soft bookmaker's commission rate. Higher commission reduces effective edge.", cat: "Staking",  fmt: "pct" },
  { name: "kelly_fraction_raw",label: "Kelly Fraction",    desc: "Raw Kelly criterion bet fraction before any adjustment. Indicates optimal stake sizing for this edge.", cat: "Staking",  fmt: "float" },
  { name: "vig_pct",           label: "Vig %",             desc: "The sharp bookmaker's overround (vigorish). Lower vig = more reliable true probability estimate.", cat: "Staking",  fmt: "pct" },
];

/** Format a raw feature value for display. */
export function formatFeatureValue(value: number, fmt: FeatureMeta["fmt"]): string {
  switch (fmt) {
    case "pct":
      return `${value.toFixed(2)}%`;
    case "odds":
      return value.toFixed(4);
    case "ms":
      // Show ms < 1000 as "Xms", else as "X.Xs"
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
