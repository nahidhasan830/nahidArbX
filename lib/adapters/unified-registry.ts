/**
 * Unified Provider Adapter Registry
 *
 * Single source of truth for both event and atoms adapters.
 * Consolidates lib/adapters/index.ts and lib/atoms/adapters/registry.ts
 *
 * NEW PROVIDER CHECKLIST (4 steps):
 * 1. Add provider metadata       → lib/providers/registry.ts
 * 2. Create adapter class        → lib/atoms/adapters/<provider>.ts (extend BaseAtomsAdapter)
 * 3. Create mapping function     → lib/atoms/mappings/<provider>.ts
 * 4. Register adapters here      → lib/adapters/unified-registry.ts
 *
 * Optional: Create event adapter (lib/adapters/<provider>.ts) if events come from
 * a different source than existing providers.
 */

import type { ProviderAdapter } from "../types";
import { PROVIDER_REGISTRY, type ProviderKey } from "../providers/registry";
import { isProviderRuntimeEnabled } from "../providers/runtime-state";
import type { DebugFetchResult } from "../atoms/adapters/debug-fetch";

// ============================================
// Types
// ============================================

export interface AtomsProviderAdapter {
  providerId: ProviderKey;
  fetchAndStoreOdds(
    providerEventId: string,
    normalizedEventId: string,
    homeTeam: string,
    awayTeam: string,
  ): Promise<number>;
}

export interface AtomsProviderDebugAdapter {
  providerId: ProviderKey;
  debugFetchAndStoreOdds(
    providerEventId: string,
    normalizedEventId: string,
    homeTeam: string,
    awayTeam: string,
  ): Promise<DebugFetchResult>;
}

// ============================================
// Import Adapters (Direct imports, no lazy loading)
// ============================================

import { pinnacleAdapter } from "./pinnacle";
import { ninewicketsExchangeAdapter } from "./ninewickets-exchange";
import { ninewicketsSportsbookAdapter } from "./ninewickets-sportsbook";
import { betconstructAdapter } from "./betconstruct";

import { PinnacleAtomsAdapter } from "../atoms/adapters/pinnacle";
import { NineWicketsExchangeAtomsAdapter } from "../atoms/adapters/ninewickets-exchange";
import { NineWicketsSportsbookAtomsAdapter } from "../atoms/adapters/ninewickets-sportsbook";
import { BetConstructAtomsAdapter } from "../atoms/adapters/betconstruct";

// ============================================
// Adapter Instances
// ============================================

const pinnacleAtomsAdapter = new PinnacleAtomsAdapter();
const nwExchangeAtomsAdapter = new NineWicketsExchangeAtomsAdapter();
const nwSportsbookAtomsAdapter = new NineWicketsSportsbookAtomsAdapter();
const betconstructAtomsAdapter = new BetConstructAtomsAdapter();

// ============================================
// Registry
// ============================================

interface ProviderAdapters {
  events?: ProviderAdapter;
  atoms?: AtomsProviderAdapter & AtomsProviderDebugAdapter;
}

const ADAPTERS: Record<ProviderKey, ProviderAdapters> = {
  pinnacle: {
    events: pinnacleAdapter,
    atoms: pinnacleAtomsAdapter,
  },
  "ninewickets-exchange": {
    events: ninewicketsExchangeAdapter,
    atoms: nwExchangeAtomsAdapter,
  },
  "ninewickets-sportsbook": {
    events: ninewicketsSportsbookAdapter,
    atoms: nwSportsbookAtomsAdapter,
  },
  betconstruct: {
    events: betconstructAdapter,
    atoms: betconstructAtomsAdapter,
  },
};

// ============================================
// Event Adapter Functions
// ============================================

/**
 * Get all enabled event adapters. Respects BOTH the static `enabled` flag
 * in PROVIDER_REGISTRY and the runtime disabled-providers state on disk.
 */
export function getEnabledEventAdapters(): ProviderAdapter[] {
  return (Object.keys(PROVIDER_REGISTRY) as ProviderKey[])
    .filter((id) => isProviderRuntimeEnabled(id) && ADAPTERS[id]?.events)
    .map((id) => ADAPTERS[id].events!);
}

/**
 * Get a specific event adapter by provider ID
 */
export function getEventAdapter(provider: ProviderKey): ProviderAdapter | null {
  return ADAPTERS[provider]?.events ?? null;
}

// ============================================
// Atoms Adapter Functions
// ============================================

/**
 * Get all enabled atoms adapters. Respects runtime disabled-providers state
 * so odds aren't fetched for providers the user has turned off.
 */
export function getEnabledAtomsAdapters(): AtomsProviderAdapter[] {
  return (Object.keys(PROVIDER_REGISTRY) as ProviderKey[])
    .filter((id) => isProviderRuntimeEnabled(id) && ADAPTERS[id]?.atoms)
    .map((id) => ADAPTERS[id].atoms!);
}

/**
 * Get a specific atoms adapter by provider ID
 */
export function getAtomsAdapter(
  provider: ProviderKey,
): AtomsProviderAdapter | undefined {
  return ADAPTERS[provider]?.atoms;
}

/**
 * Get a debug atoms adapter by provider ID
 */
export function getAtomsDebugAdapter(
  provider: ProviderKey,
): AtomsProviderDebugAdapter | undefined {
  return ADAPTERS[provider]?.atoms;
}
