/**
 * Providers API
 *
 * GET  → { providers: [{ id, displayName, enabled, runtimeEnabled, ... }] }
 *        Lists metadata + current enabled state (static + runtime).
 *
 * POST { action: "setEnabled", provider: <id>, enabled: boolean }
 *      → toggles a single provider. Also purges that provider's data from the
 *        in-memory event store so the UI updates immediately instead of waiting
 *        for the next sync.
 *
 * POST { action: "setDisabled", disabled: string[] }
 *      → replace the disabled set in one call (used for bulk sync).
 */

import { NextRequest, NextResponse } from "next/server";
import {
  PROVIDER_REGISTRY,
  PROVIDER_IDS,
  type ProviderKey,
} from "@/lib/providers/registry";
import {
  getRuntimeDisabledProviders,
  isProviderRuntimeEnabled,
  setProviderRuntimeEnabled,
  setDisabledProviders,
} from "@/lib/providers/runtime-state";
import { getEvents, setEvents } from "@/lib/store";
import { resetMatchCache } from "@/lib/matching/match-cache";
import type { NormalizedEvent } from "@/lib/types";
import { logger } from "@/lib/shared/logger";
import { getAtomsAdapter } from "@/lib/adapters/unified-registry";

/**
 * Apply provider-specific side effects when flipping runtime state.
 * Adapters that hold persistent connections (WebSockets, pollers) implement
 * onEnable/onDisable hooks themselves; this just dispatches.
 */
function applyRuntimeSideEffects(
  provider: ProviderKey,
  enabled: boolean,
): void {
  const adapter = getAtomsAdapter(provider);
  if (!adapter) return;
  if (enabled) {
    if (!adapter.onEnable) return;
    // Fire and forget — onEnable may be async but we don't want to block the API
    Promise.resolve(adapter.onEnable()).catch((err: Error) =>
      logger.warn(
        "ProvidersAPI",
        `${provider} onEnable failed: ${err.message}`,
      ),
    );
  } else {
    adapter.onDisable?.();
  }
}

/**
 * Remove a provider's data from every event in the store. Any event that ends
 * up without providers is dropped entirely. Re-enabling will repopulate on
 * the next sync.
 */

function purgeProviderFromStore(provider: ProviderKey): number {
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
  // Match cache can reference events we just touched; invalidate it.
  resetMatchCache();
  return affected;
}

export async function GET() {
  const disabled = getRuntimeDisabledProviders();
  const providers = PROVIDER_IDS.map((id) => {
    const meta = PROVIDER_REGISTRY[id];
    return {
      id,
      displayName: meta.displayName,
      shortName: meta.shortName,
      source: meta.source,
      bookmakerType: meta.bookmakerType,
      staticEnabled: meta.enabled,
      runtimeEnabled: isProviderRuntimeEnabled(id),
    };
  });
  return NextResponse.json({
    providers,
    disabled: Array.from(disabled),
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    if (action === "setEnabled") {
      const { provider, enabled } = body as {
        provider: ProviderKey;
        enabled: boolean;
      };
      if (!PROVIDER_REGISTRY[provider]) {
        return NextResponse.json(
          { error: `Unknown provider: ${provider}` },
          { status: 400 },
        );
      }
      setProviderRuntimeEnabled(provider, enabled);
      applyRuntimeSideEffects(provider, enabled);
      const purged = enabled ? 0 : purgeProviderFromStore(provider);
      logger.info(
        "ProvidersAPI",
        `${provider} ${enabled ? "enabled" : "disabled"} (purged ${purged} events)`,
      );
      return NextResponse.json({
        success: true,
        provider,
        enabled,
        purgedEvents: purged,
      });
    }

    if (action === "setDisabled") {
      const { disabled } = body as { disabled: ProviderKey[] };
      if (!Array.isArray(disabled)) {
        return NextResponse.json(
          { error: "disabled must be an array" },
          { status: 400 },
        );
      }
      // Validate IDs before applying so a typo can't wedge the state
      for (const id of disabled) {
        if (!PROVIDER_REGISTRY[id]) {
          return NextResponse.json(
            { error: `Unknown provider: ${id}` },
            { status: 400 },
          );
        }
      }
      // Snapshot previous state so we can detect transitions in both directions.
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
      return NextResponse.json({
        success: true,
        disabled,
        purgedEvents: totalPurged,
      });
    }

    return NextResponse.json(
      { error: `Unknown action: ${action}` },
      { status: 400 },
    );
  } catch (err) {
    logger.error("ProvidersAPI", `POST failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
