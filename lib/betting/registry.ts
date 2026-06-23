import type { BettingProviderAdapter } from "./types";
import { ninewicketsSportsbookAdapter } from "./ninewickets/adapter";
import { velkiSportsbookBettingAdapter } from "./velki/adapter";
import { CONFIGURED_BETTING_PROVIDER_IDS } from "./configured-ids";

export { CONFIGURED_BETTING_PROVIDER_IDS };

export const BETTING_PROVIDERS: Record<string, BettingProviderAdapter> = {
  [ninewicketsSportsbookAdapter.providerId]: ninewicketsSportsbookAdapter,
  [velkiSportsbookBettingAdapter.providerId]: velkiSportsbookBettingAdapter,
};

export function getBettingProvider(
  providerId: string,
): BettingProviderAdapter | null {
  return BETTING_PROVIDERS[providerId] ?? null;
}

export function listBettingProviders(): BettingProviderAdapter[] {
  return Object.values(BETTING_PROVIDERS);
}
