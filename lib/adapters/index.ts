
import type { ProviderAdapter } from "../types";
import type { ProviderKey } from "../providers/registry";
import {
  getEnabledEventAdapters,
  getEventAdapter as getEventAdapterFromUnified,
} from "./unified-registry";


export function getEnabledAdapters(): ProviderAdapter[] {
  return getEnabledEventAdapters();
}

export function getAdapter(provider: ProviderKey): ProviderAdapter | null {
  return getEventAdapterFromUnified(provider);
}
