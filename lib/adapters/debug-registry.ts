
import type { ProviderKey } from "../providers/registry";
import type { DebugFixturesFetchResult } from "./debug-fetch";
import { debugFetchPinnacleEvents } from "./pinnacle";
import { debugFetchNinewicketsExchangeEvents } from "./ninewickets-exchange";
import { debugFetchNinewicketsSportsbookEvents } from "./ninewickets-sportsbook";
import { debugFetchSabaSportsbookEvents } from "./saba-sportsbook";

type DebugFetchFunction = () => Promise<DebugFixturesFetchResult>;

const debugFetchers: Partial<Record<ProviderKey, DebugFetchFunction>> = {
  pinnacle: debugFetchPinnacleEvents,
  "ninewickets-exchange": debugFetchNinewicketsExchangeEvents,
  "ninewickets-sportsbook": debugFetchNinewicketsSportsbookEvents,
  "saba-sportsbook": debugFetchSabaSportsbookEvents,
};

export function getDebugFetcher(
  provider: ProviderKey,
): DebugFetchFunction | null {
  return debugFetchers[provider] ?? null;
}
