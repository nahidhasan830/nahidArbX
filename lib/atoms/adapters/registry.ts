/**
 * Atoms Adapter Registry
 *
 * Backward-compatible re-exports from unified-registry.ts.
 * For new code, import directly from lib/adapters/unified-registry.ts
 */

import type { ProviderKey } from "../../providers/registry";
import {
  getAtomsAdapter as getAdapterFromUnified,
  getEnabledAtomsAdapters as getEnabledFromUnified,
  type AtomsProviderAdapter,
} from "../../adapters/unified-registry";

// ============================================
// Re-export Types
// ============================================

export type { AtomsProviderAdapter };

// ============================================
// Re-export Functions (Backward Compatibility)
// ============================================

/**
 * Get a specific atoms adapter
 */
export function getAtomsAdapter(
  providerId: ProviderKey,
): AtomsProviderAdapter | undefined {
  return getAdapterFromUnified(providerId);
}

/**
 * Get all enabled atoms adapters
 */
export function getEnabledAtomsAdapters(): AtomsProviderAdapter[] {
  return getEnabledFromUnified();
}


