/**
 * Date preset definitions for the Bets History toolbar.
 * Uses date-fns for clean, timezone-safe date math.
 * Each preset resolves to { from?, to? } ISO strings that map
 * directly to the `from`/`to` (captured time) or `eventFrom`/`eventTo`
 * (kickoff time) filter fields.
 */
import {
  startOfDay,
  endOfDay,
  subDays,
  startOfMonth,
  subHours,
} from "date-fns";

export type DatePresetKey =
  | "last1h"
  | "last3h"
  | "last6h"
  | "last12h"
  | "today"
  | "yesterday"
  | "last3d"
  | "last7d"
  | "last15d"
  | "thisMonth"
  | "last30d"
  | "last60d"
  | "last90d"
  | "all"
  | "custom";

export type DatePreset = {
  key: DatePresetKey;
  label: string;
  /** Resolve the preset to from/to ISO strings. "all" returns {}. */
  resolve: () => { from?: string; to?: string };
};

/** Helper: resolve a preset key to { from?, to? }. Returns {} for "all". */
export function resolvePreset(key: DatePresetKey): {
  from?: string;
  to?: string;
} {
  if (key === "all") return {};
  if (key === "custom") return {}; // custom is handled by the UI
  const preset = DATE_PRESETS.find((p) => p.key === key);
  return preset ? preset.resolve() : {};
}

/**
 * Try to match current from/to filter values to a known preset key.
 * Returns "custom" if no preset matches, "all" if both are undefined.
 */
export function detectPreset(from?: string, to?: string): DatePresetKey {
  if (!from && !to) return "all";
  for (const p of DATE_PRESETS) {
    if (p.key === "custom" || p.key === "all") continue;
    const { from: pf, to: pt } = p.resolve();
    if (pf === from && pt === to) return p.key;
  }
  return "custom";
}

export const DATE_PRESETS: DatePreset[] = [
  {
    key: "last1h",
    label: "Last Hour",
    resolve: () => ({
      from: subHours(new Date(), 1).toISOString(),
      to: new Date().toISOString(),
    }),
  },
  {
    key: "last3h",
    label: "Last 3 Hours",
    resolve: () => ({
      from: subHours(new Date(), 3).toISOString(),
      to: new Date().toISOString(),
    }),
  },
  {
    key: "last6h",
    label: "Last 6 Hours",
    resolve: () => ({
      from: subHours(new Date(), 6).toISOString(),
      to: new Date().toISOString(),
    }),
  },
  {
    key: "last12h",
    label: "Last 12 Hours",
    resolve: () => ({
      from: subHours(new Date(), 12).toISOString(),
      to: new Date().toISOString(),
    }),
  },
  {
    key: "today",
    label: "Today",
    resolve: () => ({
      from: startOfDay(new Date()).toISOString(),
      to: endOfDay(new Date()).toISOString(),
    }),
  },
  {
    key: "yesterday",
    label: "Yesterday",
    resolve: () => {
      const y = subDays(new Date(), 1);
      return {
        from: startOfDay(y).toISOString(),
        to: endOfDay(y).toISOString(),
      };
    },
  },
  {
    key: "last3d",
    label: "Last 3 Days",
    resolve: () => ({
      from: startOfDay(subDays(new Date(), 2)).toISOString(),
      to: endOfDay(new Date()).toISOString(),
    }),
  },
  {
    key: "last7d",
    label: "Last 7 Days",
    resolve: () => ({
      from: startOfDay(subDays(new Date(), 6)).toISOString(),
      to: endOfDay(new Date()).toISOString(),
    }),
  },
  {
    key: "last15d",
    label: "Last 15 Days",
    resolve: () => ({
      from: startOfDay(subDays(new Date(), 14)).toISOString(),
      to: endOfDay(new Date()).toISOString(),
    }),
  },
  {
    key: "thisMonth",
    label: "This Month",
    resolve: () => ({
      from: startOfMonth(new Date()).toISOString(),
      to: endOfDay(new Date()).toISOString(),
    }),
  },
  {
    key: "last30d",
    label: "Last 30 Days",
    resolve: () => ({
      from: startOfDay(subDays(new Date(), 29)).toISOString(),
      to: endOfDay(new Date()).toISOString(),
    }),
  },
  {
    key: "last60d",
    label: "Last 2 Months",
    resolve: () => ({
      from: startOfDay(subDays(new Date(), 59)).toISOString(),
      to: endOfDay(new Date()).toISOString(),
    }),
  },
  {
    key: "last90d",
    label: "Last 3 Months",
    resolve: () => ({
      from: startOfDay(subDays(new Date(), 89)).toISOString(),
      to: endOfDay(new Date()).toISOString(),
    }),
  },
  {
    key: "all",
    label: "All Time",
    resolve: () => ({}),
  },
  {
    key: "custom",
    label: "Custom…",
    resolve: () => {
      throw new Error("Custom preset must be handled by UI");
    },
  },
];
