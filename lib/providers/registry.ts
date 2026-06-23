
import type { OddsSource } from "../types";


export type BookmakerType = "sharp" | "soft";

export interface ProviderMetadata {
  id: string;
  shortName: string;
  displayName: string;
  source: OddsSource;
  bookmakerType: BookmakerType;
  integration: {
    kind: "polling" | "websocket" | "managed";
    platform?: "genius-sports" | "pinnacle" | "betconstruct" | "saba";
    dataSourceLabel?: string;
    requiresPlacementConfirmation?: boolean;
    placeable?: boolean;
    contributesToDataHealth?: boolean;
    observationWeight: number;
    timeoutMs: number;
  };
  color: {
    bg: string;
    text: string;
    bgDark: string;
    textDark: string;
    accent: string;
    border: string;
    borderDark: string;
    chartStroke: string;
    chartDot: string;
    textInline: string;
    chartHex: string;
  };
  requiresAuth: boolean;
  enabled: boolean;
  commissionPct: number;
  fetch: {
    concurrency: number;
  };
}

export const DEFAULT_FETCH_CONCURRENCY = 20;


export const PROVIDER_REGISTRY = {
  pinnacle: {
    id: "pinnacle",
    shortName: "Pinnacle",
    displayName: "Pinnacle",
    source: "exchange" as const,
    bookmakerType: "sharp" as const, // Benchmark - most accurate odds
    integration: {
      kind: "websocket" as const,
      platform: "pinnacle" as const,
      dataSourceLabel: "Pinnacle WebSocket",
      contributesToDataHealth: true,
      observationWeight: 3,
      timeoutMs: 30_000,
    },
    color: {
      bg: "bg-blue-50",
      text: "text-blue-700",
      bgDark: "dark:bg-blue-900/30",
      textDark: "dark:text-blue-300",
      accent: "bg-blue-600",
      border: "border-blue-200",
      borderDark: "dark:border-blue-800",
      chartStroke: "stroke-cyan-400",
      chartDot: "bg-cyan-400",
      textInline: "text-cyan-400 dark:text-cyan-300",
      chartHex: "#22d3ee", // cyan-400
    },
    requiresAuth: true,
    enabled: true,
    commissionPct: 0, // Sharp bookmaker, margin built into odds
    fetch: { concurrency: 25 },
  },
  "ninewickets-exchange": {
    id: "ninewickets-exchange",
    shortName: "9W-Ex",
    displayName: "9W Exchange",
    source: "exchange" as const,
    bookmakerType: "soft" as const, // Target for value betting
    integration: {
      kind: "polling" as const,
      contributesToDataHealth: true,
      observationWeight: 2,
      timeoutMs: 60_000,
    },
    color: {
      bg: "bg-violet-50",
      text: "text-violet-700",
      bgDark: "dark:bg-violet-900/30",
      textDark: "dark:text-violet-300",
      accent: "bg-violet-600",
      border: "border-violet-200",
      borderDark: "dark:border-violet-800",
      chartStroke: "stroke-purple-400",
      chartDot: "bg-purple-400",
      textInline: "text-purple-400 dark:text-purple-300",
      chartHex: "#c084fc", // purple-400
    },
    requiresAuth: false,
    enabled: true,
    commissionPct: 5, // Exchange commission on winnings
    fetch: { concurrency: 30 },
  },
  "ninewickets-sportsbook": {
    id: "ninewickets-sportsbook",
    shortName: "9W-SB",
    displayName: "9W Sportsbook",
    source: "sportsbook" as const,
    bookmakerType: "soft" as const, // Target for value betting
    integration: {
      kind: "polling" as const,
      platform: "genius-sports" as const,
      dataSourceLabel: "Genius Sports Polling",
      requiresPlacementConfirmation: true,
      placeable: true,
      contributesToDataHealth: true,
      observationWeight: 2,
      timeoutMs: 60_000,
    },
    color: {
      bg: "bg-amber-50",
      text: "text-amber-700",
      bgDark: "dark:bg-amber-900/30",
      textDark: "dark:text-amber-300",
      accent: "bg-amber-600",
      border: "border-amber-200",
      borderDark: "dark:border-amber-800",
      chartStroke: "stroke-amber-400",
      chartDot: "bg-amber-400",
      textInline: "text-amber-400 dark:text-amber-300",
      chartHex: "#fbbf24", // amber-400
    },
    requiresAuth: false,
    enabled: true,
    commissionPct: 0, // Sportsbook, margin built into odds
    fetch: { concurrency: 30 },
  },
  betconstruct: {
    id: "betconstruct",
    shortName: "BC",
    displayName: "BetConstruct",
    source: "sportsbook" as const,
    bookmakerType: "soft" as const, // Target for value betting
    integration: {
      kind: "websocket" as const,
      platform: "betconstruct" as const,
      dataSourceLabel: "BetConstruct WebSocket",
      contributesToDataHealth: true,
      observationWeight: 1,
      timeoutMs: 15_000,
    },
    color: {
      bg: "bg-emerald-50",
      text: "text-emerald-700",
      bgDark: "dark:bg-emerald-900/30",
      textDark: "dark:text-emerald-300",
      accent: "bg-emerald-600",
      border: "border-emerald-200",
      borderDark: "dark:border-emerald-800",
      chartStroke: "stroke-sky-400",
      chartDot: "bg-sky-400",
      textInline: "text-sky-400 dark:text-sky-300",
      chartHex: "#38bdf8", // sky-400
    },
    requiresAuth: false,
    enabled: false,
    commissionPct: 0, // Sportsbook, margin built into odds
    fetch: { concurrency: 50 },
  },
  "velki-sportsbook": {
    id: "velki-sportsbook",
    shortName: "Velki-SB",
    displayName: "Velki Sportsbook",
    source: "sportsbook" as const,
    bookmakerType: "soft" as const, // Target for value betting
    integration: {
      kind: "polling" as const,
      platform: "genius-sports" as const,
      dataSourceLabel: "Genius Sports Polling",
      requiresPlacementConfirmation: true,
      placeable: true,
      contributesToDataHealth: true,
      observationWeight: 2,
      timeoutMs: 60_000,
    },
    color: {
      bg: "bg-rose-50",
      text: "text-rose-700",
      bgDark: "dark:bg-rose-900/30",
      textDark: "dark:text-rose-300",
      accent: "bg-rose-600",
      border: "border-rose-200",
      borderDark: "dark:border-rose-800",
      chartStroke: "stroke-rose-400",
      chartDot: "bg-rose-400",
      textInline: "text-rose-400 dark:text-rose-300",
      chartHex: "#fb7185", // rose-400
    },
    requiresAuth: true, // Needs DRF token + JSESSIONID handshake
    enabled: true,
    commissionPct: 0, // Sportsbook, margin built into odds
    fetch: { concurrency: 30 },
  },
  "saba-sportsbook": {
    id: "saba-sportsbook",
    shortName: "SABA",
    displayName: "SABA Sportsbook",
    source: "sportsbook" as const,
    bookmakerType: "soft" as const,
    integration: {
      kind: "polling" as const,
      platform: "saba" as const,
      dataSourceLabel: "SABA Polling",
      contributesToDataHealth: true,
      observationWeight: 1,
      timeoutMs: 60_000,
    },
    color: {
      bg: "bg-teal-50",
      text: "text-teal-700",
      bgDark: "dark:bg-teal-900/30",
      textDark: "dark:text-teal-300",
      accent: "bg-teal-600",
      border: "border-teal-200",
      borderDark: "dark:border-teal-800",
      chartStroke: "stroke-teal-400",
      chartDot: "bg-teal-400",
      textInline: "text-teal-400 dark:text-teal-300",
      chartHex: "#2dd4bf",
    },
    requiresAuth: true,
    enabled: true,
    commissionPct: 0,
    fetch: { concurrency: 30 },
  },
} as const;


export type ProviderKey = keyof typeof PROVIDER_REGISTRY;
export const PROVIDER_IDS = Object.keys(PROVIDER_REGISTRY) as ProviderKey[];


export function getEnabledProviderIds(): ProviderKey[] {
  return PROVIDER_IDS.filter((id) => PROVIDER_REGISTRY[id].enabled);
}

export function getProviderDisplayName(id: string): string {
  return PROVIDER_REGISTRY[id as ProviderKey]?.displayName ?? id;
}

export function getProviderShortName(id: string): string {
  return PROVIDER_REGISTRY[id as ProviderKey]?.shortName ?? id;
}

export function getProviderLabel(id: string): string {
  return PROVIDER_REGISTRY[id as ProviderKey]?.displayName ?? id;
}

export function getProviderColorClasses(id: string): string {
  const provider = PROVIDER_REGISTRY[id as ProviderKey];
  if (!provider) {
    return "bg-gray-50 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300 border border-gray-200 dark:border-gray-800";
  }
  const c = provider.color;
  return `${c.bg} ${c.text} ${c.bgDark} ${c.textDark} border ${c.border} ${c.borderDark}`;
}

export function isProviderEnabled(id: string): boolean {
  return PROVIDER_REGISTRY[id as ProviderKey]?.enabled ?? false;
}

export function getProviderSource(id: string): OddsSource | undefined {
  return PROVIDER_REGISTRY[id as ProviderKey]?.source;
}


export function getSharpProviders(): ProviderKey[] {
  return PROVIDER_IDS.filter(
    (id) =>
      PROVIDER_REGISTRY[id].enabled &&
      PROVIDER_REGISTRY[id].bookmakerType === "sharp",
  );
}

export function getSoftProviders(): ProviderKey[] {
  return PROVIDER_IDS.filter(
    (id) =>
      PROVIDER_REGISTRY[id].enabled &&
      PROVIDER_REGISTRY[id].bookmakerType === "soft",
  );
}

export function getDisabledSoftProviderIds(): string[] {
  return PROVIDER_IDS.filter(
    (id) =>
      !PROVIDER_REGISTRY[id].enabled &&
      PROVIDER_REGISTRY[id].bookmakerType === "soft",
  );
}

export function isSharpProvider(id: string): boolean {
  return PROVIDER_REGISTRY[id as ProviderKey]?.bookmakerType === "sharp";
}

export function isSoftProvider(id: string): boolean {
  return PROVIDER_REGISTRY[id as ProviderKey]?.bookmakerType === "soft";
}

export function getBookmakerType(id: string): BookmakerType | undefined {
  return PROVIDER_REGISTRY[id as ProviderKey]?.bookmakerType;
}

export function getProviderCommission(id: string): number {
  return PROVIDER_REGISTRY[id as ProviderKey]?.commissionPct ?? 0;
}

export function getProviderConcurrency(id: string): number {
  return (
    PROVIDER_REGISTRY[id as ProviderKey]?.fetch.concurrency ??
    DEFAULT_FETCH_CONCURRENCY
  );
}

export function getProviderTimeoutMs(id: string): number {
  return PROVIDER_REGISTRY[id as ProviderKey]?.integration.timeoutMs ?? 15_000;
}

export function getProviderObservationWeight(id: string): number {
  return (
    PROVIDER_REGISTRY[id as ProviderKey]?.integration.observationWeight ?? 1
  );
}

export function providerRequiresPlacementConfirmation(id: string): boolean {
  const integration = PROVIDER_REGISTRY[id as ProviderKey]?.integration;
  return (
    Boolean(integration) &&
    "requiresPlacementConfirmation" in integration &&
    integration.requiresPlacementConfirmation === true
  );
}

export function isPlaceableProvider(id: string): boolean {
  const integration = PROVIDER_REGISTRY[id as ProviderKey]?.integration;
  return (
    Boolean(integration) &&
    "placeable" in integration &&
    integration.placeable === true
  );
}

export function getPlaceableProviderIds(): ProviderKey[] {
  return PROVIDER_IDS.filter((id) => isPlaceableProvider(id));
}

export function getDataHealthProviderIds(): ProviderKey[] {
  return PROVIDER_IDS.filter((id) => {
    const integration = PROVIDER_REGISTRY[id].integration;
    return (
      PROVIDER_REGISTRY[id].enabled &&
      integration.contributesToDataHealth === true
    );
  });
}

export function getProviderDataSourceLabels(
  providerIds: readonly string[] = PROVIDER_IDS,
): string[] {
  const labels = new Set<string>();
  for (const id of providerIds) {
    const integration = PROVIDER_REGISTRY[id as ProviderKey]?.integration;
    const label =
      integration && "dataSourceLabel" in integration
        ? integration.dataSourceLabel
        : undefined;
    if (label) labels.add(label);
  }
  return Array.from(labels);
}

export function getProviderChartStroke(id: string): string {
  return (
    PROVIDER_REGISTRY[id as ProviderKey]?.color.chartStroke ?? "stroke-primary"
  );
}

export function getProviderChartDot(id: string): string {
  return PROVIDER_REGISTRY[id as ProviderKey]?.color.chartDot ?? "bg-primary";
}

export function getProviderTextInline(id: string): string {
  return (
    PROVIDER_REGISTRY[id as ProviderKey]?.color.textInline ??
    "text-muted-foreground"
  );
}

export function getProviderChartHex(id: string): string {
  return PROVIDER_REGISTRY[id as ProviderKey]?.color.chartHex ?? "#94a3b8";
}
