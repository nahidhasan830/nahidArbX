import {
  startOfDay,
  endOfDay,
  subDays,
  startOfMonth,
  startOfWeek,
  subHours,
} from "date-fns";

export type DatePresetKey =
  | "last1h"
  | "last3h"
  | "last6h"
  | "last12h"
  | "last24h"
  | "last48h"
  | "today"
  | "yesterday"
  | "thisWeek"
  | "lastWeek"
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
  resolve: () => { from?: string; to?: string };
};

export function resolvePreset(key: DatePresetKey): {
  from?: string;
  to?: string;
} {
  if (key === "all") return {};
  if (key === "custom") return {};
  const preset = DATE_PRESETS.find((p) => p.key === key);
  return preset ? preset.resolve() : {};
}

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
    key: "last24h",
    label: "Last 24 Hours",
    resolve: () => ({
      from: subHours(new Date(), 24).toISOString(),
      to: new Date().toISOString(),
    }),
  },
  {
    key: "last48h",
    label: "Last 48 Hours",
    resolve: () => ({
      from: subHours(new Date(), 48).toISOString(),
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
    key: "thisWeek",
    label: "This Week",
    resolve: () => ({
      from: startOfWeek(new Date(), { weekStartsOn: 1 }).toISOString(),
      to: endOfDay(new Date()).toISOString(),
    }),
  },
  {
    key: "lastWeek",
    label: "Last Week",
    resolve: () => {
      const prevWeekStart = startOfWeek(subDays(new Date(), 7), {
        weekStartsOn: 1,
      });
      const prevWeekEnd = endOfDay(
        subDays(startOfWeek(new Date(), { weekStartsOn: 1 }), 1),
      );
      return {
        from: prevWeekStart.toISOString(),
        to: prevWeekEnd.toISOString(),
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
