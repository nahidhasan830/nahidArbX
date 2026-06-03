import { notify } from "../notifier";
import type { ProviderHealthEvent } from "../notifier/types";
import { logger } from "../shared/logger";
import { PROVIDER_HEALTH_ALERT_COOLDOWN_MS } from "../shared/constants";
import { singleton } from "../util/singleton";
import type { ProviderAlert } from "./health-alerts";
import {
  getProviderDisplayName,
  PROVIDER_IDS,
  type ProviderKey,
} from "./registry";

interface ProviderIncidentState {
  down: boolean;
  lastDownSentAt: number;
  lastRecoveredSentAt: number;
  lastDownFingerprint: string | null;
}

const incidentState = singleton("provider-health:telegram", () => ({
  providers: new Map<ProviderKey, ProviderIncidentState>(),
}));

function stateFor(provider: ProviderKey): ProviderIncidentState {
  const existing = incidentState.providers.get(provider);
  if (existing) return existing;
  const created: ProviderIncidentState = {
    down: false,
    lastDownSentAt: 0,
    lastRecoveredSentAt: 0,
    lastDownFingerprint: null,
  };
  incidentState.providers.set(provider, created);
  return created;
}

export function getProviderHealthTelegramDecision(input: {
  provider: ProviderKey;
  alert: ProviderAlert | null;
  nowMs: number;
  cooldownMs?: number;
}): "down" | "recovered" | null {
  const state = stateFor(input.provider);
  const cooldownMs = input.cooldownMs ?? PROVIDER_HEALTH_ALERT_COOLDOWN_MS;

  if (input.alert?.severity === "down") {
    const shouldSend =
      !state.down ||
      input.nowMs - state.lastDownSentAt >= cooldownMs;
    state.down = true;
    state.lastDownFingerprint = input.alert.fingerprint;
    if (!shouldSend) return null;
    state.lastDownSentAt = input.nowMs;
    return "down";
  }

  if (!state.down) return null;
  state.down = false;
  state.lastDownFingerprint = null;
  state.lastRecoveredSentAt = input.nowMs;
  return "recovered";
}

export async function notifyProviderHealthTransitions(
  alerts: readonly ProviderAlert[],
  now = new Date(),
): Promise<void> {
  const downAlertsByProvider = new Map<ProviderKey, ProviderAlert>();
  for (const alert of alerts) {
    if (alert.severity === "down") {
      downAlertsByProvider.set(alert.provider, alert);
    }
  }

  await Promise.all(
    PROVIDER_IDS.map(async (provider) => {
      const alert = downAlertsByProvider.get(provider) ?? null;
      const decision = getProviderHealthTelegramDecision({
        provider,
        alert,
        nowMs: now.getTime(),
      });
      if (!decision) return;

      const event: ProviderHealthEvent =
        decision === "down"
          ? {
              type: "provider:health",
              at: now.toISOString(),
              state: "down",
              provider: alert!.provider,
              displayName: alert!.displayName,
              severity: alert!.severity,
              status: alert!.status,
              reason: alert!.reason,
              action: alert!.action,
              lastSuccessAt: alert!.lastSuccessAt,
              consecutiveFailures: alert!.consecutiveFailures,
              fingerprint: alert!.fingerprint,
            }
          : {
              type: "provider:health",
              at: now.toISOString(),
              state: "recovered",
              provider,
              displayName: getProviderDisplayName(provider),
              reason: "provider health recovered",
              action: "No action needed.",
              lastSuccessAt: null,
              consecutiveFailures: 0,
              fingerprint: `${provider}|recovered|${now.toISOString()}`,
            };

      try {
        await notify(event);
      } catch (err) {
        logger.warn(
          "ProviderHealth",
          `Telegram provider-health notify failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }),
  );
}

export function resetProviderHealthTelegramState(): void {
  incidentState.providers.clear();
}
