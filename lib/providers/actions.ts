import { type ProviderKey } from "./registry";
import {
  setProviderRuntimeEnabled,
  setDisabledProviders,
  isProviderRuntimeEnabled,
} from "./runtime-state";
import { getEvents, setEvents } from "../store";
import { resetMatchCache } from "../matching/match-cache";
import type { NormalizedEvent } from "../types";
import { logger } from "../shared/logger";
import { getAtomsAdapter } from "../adapters/unified-registry";
import { PROVIDER_IDS } from "./registry";

export function applyRuntimeSideEffects(
  provider: ProviderKey,
  enabled: boolean,
): void {
  const adapter = getAtomsAdapter(provider);
  if (!adapter) return;
  if (enabled) {
    if (!adapter.onEnable) return;
    Promise.resolve(adapter.onEnable()).catch((err: Error) =>
      logger.warn(
        "ProvidersActions",
        `${provider} onEnable failed: ${err.message}`,
      ),
    );
  } else {
    adapter.onDisable?.();
  }
}

export function purgeProviderFromStore(provider: ProviderKey): number {
  const events = getEvents();
  const kept: NormalizedEvent[] = [];
  let affected = 0;
  for (const ev of events) {
    if (ev.providers[provider]) {
      affected++;
      const rest = { ...ev.providers };
      delete rest[provider];
      if (Object.keys(rest).length === 0) {
        continue; // event had only this provider — drop it entirely
      }
      kept.push({ ...ev, providers: rest });
    } else {
      kept.push(ev);
    }
  }
  setEvents(kept);
  resetMatchCache();
  return affected;
}

export function toggleProviderAction(provider: ProviderKey, enabled: boolean) {
  setProviderRuntimeEnabled(provider, enabled);
  applyRuntimeSideEffects(provider, enabled);
  const purged = enabled ? 0 : purgeProviderFromStore(provider);
  logger.info(
    "ProvidersActions",
    `${provider} ${enabled ? "enabled" : "disabled"} (purged ${purged} events)`,
  );
  return purged;
}

export function setDisabledProvidersAction(disabled: ProviderKey[]) {
  const prevEnabled = new Set(
    PROVIDER_IDS.filter((id) => isProviderRuntimeEnabled(id)),
  );
  setDisabledProviders(disabled);
  let totalPurged = 0;
  for (const id of PROVIDER_IDS) {
    const nowEnabled = isProviderRuntimeEnabled(id);
    const wasEnabled = prevEnabled.has(id);
    if (wasEnabled !== nowEnabled) {
      applyRuntimeSideEffects(id, nowEnabled);
    }
    if (wasEnabled && !nowEnabled) {
      totalPurged += purgeProviderFromStore(id);
    }
  }
  return totalPurged;
}
