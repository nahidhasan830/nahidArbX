
import type { ProviderKey } from "../../providers/registry";
import {
  getAtomsAdapter as getAdapterFromUnified,
  getEnabledAtomsAdapters as getEnabledFromUnified,
  type AtomsProviderAdapter,
} from "../../adapters/unified-registry";


export type { AtomsProviderAdapter };


export function getAtomsAdapter(
  providerId: ProviderKey,
): AtomsProviderAdapter | undefined {
  return getAdapterFromUnified(providerId);
}

export function getEnabledAtomsAdapters(): AtomsProviderAdapter[] {
  return getEnabledFromUnified();
}
