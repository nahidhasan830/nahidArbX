/**
 * Human-readable formatting for strategy filters and sizing.
 * Used by the dashboard BettingStrategyCard tooltip.
 */

import type { StrategyFilters, StrategySizing } from "./strategy-filters";
import { getProviderShortName } from "@/lib/providers/registry";

export type { StrategyFilters, StrategySizing };

interface DetailRow {
  label: string;
  value: string;
}

const fmtNum = (n: number): string =>
  Number.isFinite(n) ? n.toFixed(3).replace(/\.?0+$/, "") : "—";

export function formatFilterChips(filters: StrategyFilters): string[] {
  const out: string[] = [];
  if (typeof filters.min_ev_pct === "number")
    out.push(`EV ≥ ${fmtNum(filters.min_ev_pct)}%`);
  if (filters.odds_lo != null || filters.odds_hi != null) {
    const lo = filters.odds_lo != null ? fmtNum(filters.odds_lo) : "−∞";
    const hi = filters.odds_hi != null ? fmtNum(filters.odds_hi) : "∞";
    out.push(`Odds ${lo}–${hi}`);
  }
  if (typeof filters.min_sharp_prob === "number")
    out.push(`Sharp ≥ ${fmtNum(filters.min_sharp_prob)}`);
  if (filters.pre_match_only === true) out.push("Pre-match");
  return out;
}

export function formatStrategyDetails(
  filters: StrategyFilters,
  sizing: StrategySizing | null | undefined,
): { filters: DetailRow[]; sizing: DetailRow[] } {
  const filterRows: DetailRow[] = [];

  if (typeof filters.min_ev_pct === "number")
    filterRows.push({
      label: "Min EV",
      value: `${fmtNum(filters.min_ev_pct)}%`,
    });
  if (filters.odds_lo != null || filters.odds_hi != null) {
    const lo = filters.odds_lo != null ? fmtNum(filters.odds_lo) : "−∞";
    const hi = filters.odds_hi != null ? fmtNum(filters.odds_hi) : "∞";
    filterRows.push({ label: "Odds range", value: `${lo} – ${hi}` });
  }
  if (typeof filters.min_sharp_prob === "number")
    filterRows.push({
      label: "Sharp prob ≥",
      value: fmtNum(filters.min_sharp_prob),
    });

  if (typeof filters.min_tick_count === "number")
    filterRows.push({
      label: "Min ticks",
      value: String(filters.min_tick_count),
    });
  if (filters.pre_match_only === true)
    filterRows.push({ label: "Pre-match only", value: "Yes" });
  if (
    Array.isArray(filters.soft_providers) &&
    filters.soft_providers.length > 0
  )
    filterRows.push({
      label: "Providers",
      value: filters.soft_providers
        .map((p) => getProviderShortName(p))
        .join(", "),
    });
  if (Array.isArray(filters.market_types) && filters.market_types.length > 0)
    filterRows.push({
      label: "Markets",
      value: filters.market_types.join(", "),
    });

  const sizingRows: DetailRow[] = [];
  if (sizing) {
    if (typeof sizing.kelly_fraction === "number")
      sizingRows.push({
        label: "Kelly fraction",
        value: `${fmtNum(sizing.kelly_fraction)}×`,
      });
    if (typeof sizing.kelly_cap_pct === "number")
      sizingRows.push({
        label: "Kelly cap",
        value: `${fmtNum(sizing.kelly_cap_pct)}%`,
      });
    if (sizing.staking_scheme)
      sizingRows.push({ label: "Staking", value: sizing.staking_scheme });
  }

  return { filters: filterRows, sizing: sizingRows };
}
