/**
 * Registry of betting provider adapters. Add a new provider by importing
 * its adapter and dropping it into the BETTING_PROVIDERS map below.
 *
 * The generic placer (`lib/betting/placer.ts`) only talks to adapters
 * via {@link BettingProviderAdapter} — it doesn't know or care which
 * specific book it's talking to.
 */
import type { BettingProviderAdapter } from "./types";
import { ninewicketsSportsbookAdapter } from "./ninewickets/adapter";
import { CONFIGURED_BETTING_PROVIDER_IDS } from "./configured-ids";

// Re-export so server-side callers can still import from registry if they wish.
export { CONFIGURED_BETTING_PROVIDER_IDS };

/**
 * Every configured betting provider. Keys are the stable `providerId`
 * strings used throughout the codebase (DB columns, toggle keys, UI).
 */
export const BETTING_PROVIDERS: Record<string, BettingProviderAdapter> = {
  [ninewicketsSportsbookAdapter.providerId]: ninewicketsSportsbookAdapter,
};

export function getBettingProvider(
  providerId: string,
): BettingProviderAdapter | null {
  return BETTING_PROVIDERS[providerId] ?? null;
}

export function listBettingProviders(): BettingProviderAdapter[] {
  return Object.values(BETTING_PROVIDERS);
}
