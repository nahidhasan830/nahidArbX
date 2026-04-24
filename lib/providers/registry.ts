/**
 * Provider Registry — single source of truth for all provider metadata.
 *
 * ## Adding a new provider (checklist)
 *
 * 1. Add an entry to `PROVIDER_REGISTRY` below with all required metadata.
 * 2. Create `lib/adapters/<provider>.ts` implementing `ProviderAdapter`
 *    (fetches normalized events — see existing adapters for the pattern).
 * 3. Create `lib/atoms/adapters/<provider>.ts` implementing `AtomsProviderAdapter`
 *    (fetches per-event odds and stores them in the atoms store).
 * 4. Register both adapters in `lib/adapters/index.ts`.
 * 5. If the provider requires auth/tokens, add to `lib/auth/token-manager.ts`.
 *
 * No other files need to change. The pipeline picks up new providers
 * automatically through the registry.
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
  };
  requiresAuth: boolean;
  enabled: boolean;
  commissionPct: number; // Commission percentage (0-100), e.g., 5 for 5% commission on winnings
}

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
    },
    requiresAuth: true,
    enabled: true,
    commissionPct: 0, // Sharp bookmaker, margin built into odds
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
    },
    requiresAuth: false,
    enabled: true,
    commissionPct: 5, // Exchange commission on winnings
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
    },
    requiresAuth: false,
    enabled: true,
    commissionPct: 0, // Sportsbook, margin built into odds
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
    },
    requiresAuth: false,
    enabled: true,
    commissionPct: 0, // Sportsbook, margin built into odds
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
