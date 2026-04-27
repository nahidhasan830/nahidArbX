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
} from "@/lib/providers/runtime-state";
import { logger } from "@/lib/shared/logger";
import {
  toggleProviderAction,
  setDisabledProvidersAction,
} from "@/lib/providers/actions";

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
      const purged = toggleProviderAction(provider, enabled);
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
      const totalPurged = setDisabledProvidersAction(disabled);
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
