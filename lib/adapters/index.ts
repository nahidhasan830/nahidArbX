/**
 * Provider Adapters Registry
 *
 * Centralized registry for event-fetching adapters.
 * Delegates to unified-registry.ts for both event and atoms adapters.
 *
 * NEW PROVIDER CHECKLIST (4 steps):
 * 1. Add provider metadata       → lib/providers/registry.ts
 * 2. Create adapter class        → lib/atoms/adapters/<provider>.ts (extend BaseAtomsAdapter)
 * 3. Create mapping function     → lib/atoms/mappings/<provider>.ts
 * 4. Register in unified registry → lib/adapters/unified-registry.ts
 *
 * Optional: Create event adapter (lib/adapters/<provider>.ts) if events come from
 * a different source than existing providers.
 *
 * Key Utilities:
 * - BaseAtomsAdapter     → lib/atoms/adapters/base.ts (extend this for new providers)
 * - buildOddsEntry()     → lib/shared/odds-entry.ts (entry construction helper)
 * - DebugFetcher         → lib/shared/debug-fetcher.ts (debug capture utility)
 * - createProviderClient → lib/shared/http.ts (axios client factory)
 * - validateAndParse()   → lib/shared/validation.ts (Zod validation wrapper)
 */

import type { ProviderAdapter } from "../types";
import type { ProviderKey } from "../providers/registry";
import {
  getEnabledEventAdapters,
  getEventAdapter as getEventAdapterFromUnified,
} from "./unified-registry";

// ============================================
// Re-exports from Unified Registry
// ============================================

/**
 * Get all enabled adapters (enabled in registry AND has adapter implementation)
 */
export function getEnabledAdapters(): ProviderAdapter[] {
  return getEnabledEventAdapters();
}

/**
 * Get a specific adapter by provider ID
 */
export function getAdapter(provider: ProviderKey): ProviderAdapter | null {
  return getEventAdapterFromUnified(provider);
}
