/**
 * Provider Registry — single source of truth for all provider metadata.
 *
 * ## Adding a new provider (checklist)
 *
 * 1. Add an entry to `PROVIDER_REGISTRY` below — id, names, source,
 *    bookmakerType, color, commission, and `fetch.concurrency`.
 * 2. Create `lib/atoms/mappings/<provider>.ts` exporting the raw → atoms
 *    extraction function.
 * 3. Create `lib/atoms/adapters/<provider>.ts` extending `BaseAtomsAdapter`.
 *    If the provider holds a persistent connection (WebSocket, poller),
 *    implement `onEnable()` / `onDisable()` so the providers API can toggle
 *    it without provider-specific code.
 * 4. (Optional) Create `lib/adapters/<provider>.ts` if events come from a
 *    different source than an existing provider.
 * 5. Wire both adapters into `lib/adapters/unified-registry.ts`.
 * 6. If auth/tokens are needed, add to `lib/auth/token-manager.ts`.
 *
 * No other files need to change. The orchestrator, value detector, runtime
 * toggles, and UI filters all derive from the registry.
 */

import type { OddsSource } from "../types";

// ============================================
// Types
// ============================================

export type BookmakerType = "sharp" | "soft";

export interface ProviderMetadata {
  id: string;
  shortName: string; // "PL", "9W-Ex", "9W-SB"
  displayName: string; // "Pinnacle", "9W Exchange"
  source: OddsSource; // "exchange" | "sportsbook"
  bookmakerType: BookmakerType; // "sharp" = benchmark odds, "soft" = target for value
  color: {
    bg: string; // Tailwind bg class
    text: string; // Tailwind text class
    bgDark: string; // Dark mode bg
    textDark: string; // Dark mode text
    accent: string; // Status indicator
    border: string; // Border color
    borderDark: string; // Dark mode border
    chartStroke: string; // SVG stroke class for charts
    chartDot: string; // Bg class for chart legend dots
    textInline: string; // Text color for dark-mode-friendly inline labels
    chartHex: string; // Hex color for canvas charting
  };
  requiresAuth: boolean;
  enabled: boolean;
  commissionPct: number; // Commission percentage (0-100), e.g., 5 for 5% commission on winnings
  fetch: {
    concurrency: number; // Max in-flight odds fetches per cycle
  };
}

export const DEFAULT_FETCH_CONCURRENCY = 20;

// ============================================
// Registry
// ============================================

export const PROVIDER_REGISTRY = {
  pinnacle: {
    id: "pinnacle",
    shortName: "Pinnacle",
    displayName: "Pinnacle",
    source: "exchange" as const,
    bookmakerType: "sharp" as const, // Benchmark - most accurate odds
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
} as const;

// ============================================
// Derived Types
// ============================================

export type ProviderKey = keyof typeof PROVIDER_REGISTRY;
export const PROVIDER_IDS = Object.keys(PROVIDER_REGISTRY) as ProviderKey[];

// ============================================
// Helper Functions
// ============================================

/**
 * Get enabled provider IDs
 */
export function getEnabledProviderIds(): ProviderKey[] {
  return PROVIDER_IDS.filter((id) => PROVIDER_REGISTRY[id].enabled);
}

/**
 * Get display name for provider
 */
export function getProviderDisplayName(id: string): string {
  return PROVIDER_REGISTRY[id as ProviderKey]?.displayName ?? id;
}

/**
 * Get short name for provider
 */
export function getProviderShortName(id: string): string {
  return PROVIDER_REGISTRY[id as ProviderKey]?.shortName ?? id;
}

/**
 * Get display name (full label) for provider
 */
export function getProviderLabel(id: string): string {
  return PROVIDER_REGISTRY[id as ProviderKey]?.displayName ?? id;
}

/**
 * Get color classes for provider badge (includes border)
 */
export function getProviderColorClasses(id: string): string {
  const provider = PROVIDER_REGISTRY[id as ProviderKey];
  if (!provider) {
    return "bg-gray-50 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300 border border-gray-200 dark:border-gray-800";
  }
  const c = provider.color;
  return `${c.bg} ${c.text} ${c.bgDark} ${c.textDark} border ${c.border} ${c.borderDark}`;
}

/**
 * Check if provider is enabled
 */
export function isProviderEnabled(id: string): boolean {
  return PROVIDER_REGISTRY[id as ProviderKey]?.enabled ?? false;
}

/**
 * Get source type for a provider (exchange or sportsbook)
 */
export function getProviderSource(id: string): OddsSource | undefined {
  return PROVIDER_REGISTRY[id as ProviderKey]?.source;
}

// ============================================
// Bookmaker Type Helpers (Value Betting)
// ============================================

/**
 * Get all sharp (benchmark) providers
 * Sharp bookmakers have accurate odds - used as true probability source
 */
export function getSharpProviders(): ProviderKey[] {
  return PROVIDER_IDS.filter(
    (id) =>
      PROVIDER_REGISTRY[id].enabled &&
      PROVIDER_REGISTRY[id].bookmakerType === "sharp",
  );
}

/**
 * Get all soft (target) providers
 * Soft bookmakers may offer value - compare against sharp odds
 */
export function getSoftProviders(): ProviderKey[] {
  return PROVIDER_IDS.filter(
    (id) =>
      PROVIDER_REGISTRY[id].enabled &&
      PROVIDER_REGISTRY[id].bookmakerType === "soft",
  );
}

/**
 * Get IDs of disabled soft providers — used to auto-exclude from dataset queries.
 */
export function getDisabledSoftProviderIds(): string[] {
  return PROVIDER_IDS.filter(
    (id) =>
      !PROVIDER_REGISTRY[id].enabled &&
      PROVIDER_REGISTRY[id].bookmakerType === "soft",
  );
}

/**
 * Check if a provider is a sharp bookmaker
 */
export function isSharpProvider(id: string): boolean {
  return PROVIDER_REGISTRY[id as ProviderKey]?.bookmakerType === "sharp";
}

/**
 * Check if a provider is a soft bookmaker
 */
export function isSoftProvider(id: string): boolean {
  return PROVIDER_REGISTRY[id as ProviderKey]?.bookmakerType === "soft";
}

/**
 * Get bookmaker type for a provider
 */
export function getBookmakerType(id: string): BookmakerType | undefined {
  return PROVIDER_REGISTRY[id as ProviderKey]?.bookmakerType;
}

/**
 * Get commission percentage for a provider
 * Exchanges typically charge commission on winnings, sportsbooks have margin in odds
 */
export function getProviderCommission(id: string): number {
  return PROVIDER_REGISTRY[id as ProviderKey]?.commissionPct ?? 0;
}

/**
 * Get the configured per-provider concurrency limit for the odds fetcher.
 * Falls back to DEFAULT_FETCH_CONCURRENCY for unknown providers.
 */
export function getProviderConcurrency(id: string): number {
  return (
    PROVIDER_REGISTRY[id as ProviderKey]?.fetch.concurrency ??
    DEFAULT_FETCH_CONCURRENCY
  );
}

/**
 * SVG stroke class for charts (e.g. "stroke-amber-400")
 */
export function getProviderChartStroke(id: string): string {
  return (
    PROVIDER_REGISTRY[id as ProviderKey]?.color.chartStroke ?? "stroke-primary"
  );
}

/**
 * Bg class for chart legend dots (e.g. "bg-amber-400")
 */
export function getProviderChartDot(id: string): string {
  return PROVIDER_REGISTRY[id as ProviderKey]?.color.chartDot ?? "bg-primary";
}

/**
 * Dark-mode-friendly text color for inline provider labels
 * in tables and lists (e.g. "text-amber-400 dark:text-amber-300")
 */
export function getProviderTextInline(id: string): string {
  return (
    PROVIDER_REGISTRY[id as ProviderKey]?.color.textInline ??
    "text-muted-foreground"
  );
}

/**
 * Raw hex color string for canvas-based charts like lightweight-charts.
 */
export function getProviderChartHex(id: string): string {
  return PROVIDER_REGISTRY[id as ProviderKey]?.color.chartHex ?? "#94a3b8"; // slate-400 fallback
}
