/**
 * Friendly labels for optimizer search-space parameter keys.
 * Used by TrialDrawer to render the "Settings tried" section.
 */

import { getProviderShortName } from "@/lib/providers/registry";
import { formatMarketType } from "@/lib/formatting/labels";

const LABELS: Record<string, string> = {
  min_ev_pct: "Min EV %",

  min_sharp_prob: "Min sharp prob",
  odds_lo: "Odds lower bound",
  odds_hi: "Odds upper bound",
  min_tick_count: "Min tick count",
  pre_match_only: "Pre-match only",
  soft_providers: "Providers",
  market_types: "Markets",
  kelly_fraction: "Kelly fraction",
  kelly_cap_pct: "Kelly cap %",
  staking_scheme: "Staking scheme",
};

function renderValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number")
    return Number.isFinite(value)
      ? value.toFixed(4).replace(/\.?0+$/, "")
      : "—";
  if (Array.isArray(value)) {
    if (key === "soft_providers")
      return value.map((p) => getProviderShortName(String(p))).join(", ");
    if (key === "market_types")
      return value.map((m) => formatMarketType(String(m))).join(", ");
    return value.join(", ");
  }
  return String(value);
}

export function formatParam(
  key: string,
  value: unknown,
): { label: string; rendered: string } {
  return {
    label: LABELS[key] ?? key.replace(/_/g, " "),
    rendered: renderValue(key, value),
  };
}
