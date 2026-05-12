/**
 * Providers API
 *
 * GET  → lists provider metadata + enabled state (from file config).
 * POST → forwards toggle actions to engine (which owns in-memory state).
 */

import { NextRequest, NextResponse } from "next/server";
import { PROVIDER_REGISTRY, PROVIDER_IDS } from "@/lib/providers/registry";
import {
  getRuntimeDisabledProviders,
  isProviderRuntimeEnabled,
} from "@/lib/providers/runtime-state";
import { logger } from "@/lib/shared/logger";
import { enginePost } from "@/lib/engine-proxy";

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

    // Forward to engine for in-memory purge + file config update
    const result = await enginePost("/engine/providers", body);
    if (result === null) {
      // Engine unreachable — still apply file-config locally
      const { toggleProviderAction, setDisabledProvidersAction } =
        await import("@/lib/providers/actions");
      const { action } = body;

      if (action === "setEnabled") {
        const { provider, enabled } = body;
        if (!PROVIDER_REGISTRY[provider as keyof typeof PROVIDER_REGISTRY]) {
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
          _engineOffline: true,
        });
      }

      if (action === "setDisabled") {
        const { disabled } = body;
        if (!Array.isArray(disabled)) {
          return NextResponse.json(
            { error: "disabled must be an array" },
            { status: 400 },
          );
        }
        const totalPurged = setDisabledProvidersAction(disabled);
        return NextResponse.json({
          success: true,
          disabled,
          purgedEvents: totalPurged,
          _engineOffline: true,
        });
      }

      return NextResponse.json(
        { error: `Unknown action: ${body.action}` },
        { status: 400 },
      );
    }

    return NextResponse.json(result);
  } catch (err) {
    logger.error("ProvidersAPI", `POST failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
