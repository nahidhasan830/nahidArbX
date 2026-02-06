import type { ProviderAdapter, Provider } from "../types";
import { psliveAdapter } from "./pslive";
import { ninewicketsAdapter } from "./ninewickets";

const adapters: Record<Provider, ProviderAdapter | null> = {
  pslive: psliveAdapter,
  ninewickets: ninewicketsAdapter,
};

export function getEnabledAdapters(): ProviderAdapter[] {
  const enabled: ProviderAdapter[] = [];

  // pslive - always try (will check for valid token internally)
  if (adapters.pslive) {
    enabled.push(adapters.pslive);
  }

  // Nine Wickets doesn't require auth - always enable if adapter exists
  if (adapters.ninewickets) {
    enabled.push(adapters.ninewickets);
  }

  return enabled;
}

export function getAdapter(provider: Provider): ProviderAdapter | null {
  return adapters[provider];
}
