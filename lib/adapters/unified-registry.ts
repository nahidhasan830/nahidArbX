import { isProviderRuntimeEnabled } from "../providers/runtime-state";
import type { ProviderAdapter } from "../types";
import { PROVIDER_REGISTRY, type ProviderKey } from "../providers/registry";
import type { FetchContext } from "../atoms/adapters/base";

export interface AtomsFetchOptions {
  fastMode?: boolean;
}

export interface AtomsProviderAdapter {
  providerId: ProviderKey;
  fetchAndStoreOdds(
    providerEventId: string,
    normalizedEventId: string,
    homeTeam: string,
    awayTeam: string,
    options?: AtomsFetchOptions,
  ): Promise<number>;
  onEnable?(): void | Promise<void>;
  onDisable?(): void;
}

export interface RawOddsAtomsProviderAdapter extends AtomsProviderAdapter {
  processRawOdds(rawData: unknown, ctx: FetchContext): number;
}

import { pinnacleAdapter } from "./pinnacle";
import { ninewicketsExchangeAdapter } from "./ninewickets-exchange";
import { ninewicketsSportsbookAdapter } from "./ninewickets-sportsbook";
import { betconstructAdapter } from "./betconstruct";
import { velkiSportsbookAdapter } from "./velki-sportsbook";
import { sabaSportsbookAdapter } from "./saba-sportsbook";

import { PinnacleAtomsAdapter } from "../atoms/adapters/pinnacle";
import { NineWicketsExchangeAtomsAdapter } from "../atoms/adapters/ninewickets-exchange";
import { NineWicketsSportsbookAtomsAdapter } from "../atoms/adapters/ninewickets-sportsbook";
import { BetConstructAtomsAdapter } from "../atoms/adapters/betconstruct";
import { VelkiSportsbookAtomsAdapter } from "../atoms/adapters/velki-sportsbook";
import { SabaSportsbookAtomsAdapter } from "../atoms/adapters/saba-sportsbook";

const pinnacleAtomsAdapter = new PinnacleAtomsAdapter();
const nwExchangeAtomsAdapter = new NineWicketsExchangeAtomsAdapter();
const nwSportsbookAtomsAdapter = new NineWicketsSportsbookAtomsAdapter();
const betconstructAtomsAdapter = new BetConstructAtomsAdapter();
const velkiSportsbookAtomsAdapter = new VelkiSportsbookAtomsAdapter();
const sabaSportsbookAtomsAdapter = new SabaSportsbookAtomsAdapter();

interface ProviderAdapters {
  events?: ProviderAdapter;
  atoms?: AtomsProviderAdapter;
}

const ADAPTERS: Partial<Record<ProviderKey, ProviderAdapters>> = {
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
  "velki-sportsbook": {
    events: velkiSportsbookAdapter,
    atoms: velkiSportsbookAtomsAdapter,
  },
  "saba-sportsbook": {
    events: sabaSportsbookAdapter,
    atoms: sabaSportsbookAtomsAdapter,
  },
};

export function getEnabledEventAdapters(): ProviderAdapter[] {
  return (Object.keys(PROVIDER_REGISTRY) as ProviderKey[])
    .filter((id) => isProviderRuntimeEnabled(id) && ADAPTERS[id]?.events)
    .map((id) => ADAPTERS[id]!.events!);
}

export function getEventAdapter(provider: ProviderKey): ProviderAdapter | null {
  return ADAPTERS[provider]?.events ?? null;
}

export function getEnabledAtomsAdapters(): AtomsProviderAdapter[] {
  return (Object.keys(PROVIDER_REGISTRY) as ProviderKey[])
    .filter((id) => isProviderRuntimeEnabled(id) && ADAPTERS[id]?.atoms)
    .map((id) => ADAPTERS[id]!.atoms!);
}

export function getAtomsAdapter(
  provider: ProviderKey,
): AtomsProviderAdapter | undefined {
  return ADAPTERS[provider]?.atoms;
}
