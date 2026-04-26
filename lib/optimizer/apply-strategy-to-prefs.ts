/**
 * Maps strategy filters to toolbar preferences so picking a strategy
 * in the StrategyPickerPill populates the filter bar automatically.
 */

import type { StrategyFilters } from "./strategy-filters";

interface ValueBetPrefs {
  evRangeMin: number;
  softOddsRangeMin: number;
  softOddsRangeMax: number;
  selectedSoftProviders: Set<string> | string[];
  selectedMarketTypes: Set<string> | string[];
}

interface BetsHistoryPatch {
  minEv?: number;
  oddsMin?: number;
  oddsMax?: number;
  softProviders?: string[];
  marketTypes?: string[];
}

export function strategyToValueBetPrefs(filters: StrategyFilters[]): {
  evRangeMin: number;
  softOddsRangeMin: number;
  softOddsRangeMax: number;
  selectedSoftProviders: Set<string>;
  selectedMarketTypes: Set<string>;
} {
  if (filters.length === 0) {
    return {
      evRangeMin: 0,
      softOddsRangeMin: 1,
      softOddsRangeMax: 100,
      selectedSoftProviders: new Set<string>(),
      selectedMarketTypes: new Set<string>(),
    };
  }

  let evMin = Infinity;
  let oddsLo = Infinity;
  let oddsHi = -Infinity;
  const providers = new Set<string>();
  const markets = new Set<string>();

  for (const f of filters) {
    if (typeof f.min_ev_pct === "number") evMin = Math.min(evMin, f.min_ev_pct);
    if (typeof f.odds_lo === "number") oddsLo = Math.min(oddsLo, f.odds_lo);
    if (typeof f.odds_hi === "number") oddsHi = Math.max(oddsHi, f.odds_hi);
    if (Array.isArray(f.soft_providers))
      f.soft_providers.forEach((p) => providers.add(p));
    if (Array.isArray(f.market_types))
      f.market_types.forEach((m) => markets.add(m));
  }

  return {
    evRangeMin: evMin === Infinity ? 0 : evMin,
    softOddsRangeMin: oddsLo === Infinity ? 1 : oddsLo,
    softOddsRangeMax: oddsHi === -Infinity ? 100 : oddsHi,
    selectedSoftProviders: providers,
    selectedMarketTypes: markets,
  };
}

export function valueBetPrefsMatchTemplate(
  prefs: ValueBetPrefs,
  strategyFilters: StrategyFilters[],
): boolean {
  const template = strategyToValueBetPrefs(strategyFilters);
  if (prefs.evRangeMin !== template.evRangeMin) return false;
  if (prefs.softOddsRangeMin !== template.softOddsRangeMin) return false;
  if (prefs.softOddsRangeMax !== template.softOddsRangeMax) return false;

  const prefsProviders =
    prefs.selectedSoftProviders instanceof Set
      ? prefs.selectedSoftProviders
      : new Set(prefs.selectedSoftProviders);
  if (prefsProviders.size !== template.selectedSoftProviders.size) return false;
  for (const p of template.selectedSoftProviders) {
    if (!prefsProviders.has(p)) return false;
  }

  const prefsMarkets = new Set(prefs.selectedMarketTypes);
  const templateMarkets = new Set(template.selectedMarketTypes);
  if (prefsMarkets.size !== templateMarkets.size) return false;
  for (const m of templateMarkets) {
    if (!prefsMarkets.has(m)) return false;
  }

  return true;
}

export function strategyToBetsHistoryPatch(
  filters: StrategyFilters[],
): BetsHistoryPatch {
  if (filters.length === 0) return {};

  let evMin: number | undefined;
  let oddsLo: number | undefined;
  let oddsHi: number | undefined;
  const providers = new Set<string>();
  const markets = new Set<string>();

  for (const f of filters) {
    if (typeof f.min_ev_pct === "number") {
      evMin =
        evMin === undefined ? f.min_ev_pct : Math.min(evMin, f.min_ev_pct);
    }
    if (typeof f.odds_lo === "number") {
      oddsLo = oddsLo === undefined ? f.odds_lo : Math.min(oddsLo, f.odds_lo);
    }
    if (typeof f.odds_hi === "number") {
      oddsHi = oddsHi === undefined ? f.odds_hi : Math.max(oddsHi, f.odds_hi);
    }
    if (Array.isArray(f.soft_providers))
      f.soft_providers.forEach((p) => providers.add(p));
    if (Array.isArray(f.market_types))
      f.market_types.forEach((m) => markets.add(m));
  }

  return {
    minEv: evMin,
    oddsMin: oddsLo,
    oddsMax: oddsHi,
    softProviders: providers.size > 0 ? [...providers] : undefined,
    marketTypes: markets.size > 0 ? [...markets] : undefined,
  };
}

export function betsHistoryFiltersMatchTemplate(
  filters: {
    minEv?: number;
    oddsMin?: number;
    oddsMax?: number;
    softProviders?: string[];
    marketTypes?: string[];
  } & Record<string, unknown>,
  strategyFilters: StrategyFilters[],
): boolean {
  const template = strategyToBetsHistoryPatch(strategyFilters);

  if ((filters.minEv ?? undefined) !== template.minEv) return false;
  if ((filters.oddsMin ?? undefined) !== template.oddsMin) return false;
  if ((filters.oddsMax ?? undefined) !== template.oddsMax) return false;

  const fp = new Set(filters.softProviders ?? []);
  const tp = new Set(template.softProviders ?? []);
  if (fp.size !== tp.size) return false;
  for (const p of tp) {
    if (!fp.has(p)) return false;
  }

  const fm = new Set(filters.marketTypes ?? []);
  const tm = new Set(template.marketTypes ?? []);
  if (fm.size !== tm.size) return false;
  for (const m of tm) {
    if (!fm.has(m)) return false;
  }

  return true;
}
