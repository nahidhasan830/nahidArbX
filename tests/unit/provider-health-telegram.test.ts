import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/notifier", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/providers/health-telegram-settings", () => ({
  isProviderHealthTelegramEnabled: vi.fn(),
}));

import { notify } from "@/lib/notifier";
import {
  getProviderHealthTelegramDecision,
  notifyProviderHealthTransitions,
  resetProviderHealthTelegramState,
} from "@/lib/providers/health-telegram";
import type { ProviderAlert } from "@/lib/providers/health-alerts";
import { isProviderHealthTelegramEnabled } from "@/lib/providers/health-telegram-settings";

const nowMs = Date.parse("2026-06-04T12:00:00.000Z");
const cooldownMs = 15 * 60 * 1000;

function downAlert(fingerprint = "pinnacle|down|down|reason|never") {
  return {
    provider: "pinnacle",
    displayName: "Pinnacle",
    severity: "down",
    status: "down",
    reason: "circuit breaker is open",
    action: "Check provider credentials, network path, and engine logs.",
    lastSuccessAt: null,
    consecutiveFailures: 3,
    fingerprint,
  } satisfies ProviderAlert;
}

describe("provider health Telegram dedupe", () => {
  beforeEach(() => {
    resetProviderHealthTelegramState();
    vi.mocked(notify).mockClear();
    vi.mocked(isProviderHealthTelegramEnabled).mockReturnValue(true);
  });

  it("sends the first down alert and suppresses repeats within cooldown", () => {
    expect(
      getProviderHealthTelegramDecision({
        provider: "pinnacle",
        alert: downAlert(),
        nowMs,
        cooldownMs,
      }),
    ).toBe("down");

    expect(
      getProviderHealthTelegramDecision({
        provider: "pinnacle",
        alert: downAlert(),
        nowMs: nowMs + 60_000,
        cooldownMs,
      }),
    ).toBeNull();
  });

  it("sends repeated down alert after cooldown", () => {
    getProviderHealthTelegramDecision({
      provider: "pinnacle",
      alert: downAlert(),
      nowMs,
      cooldownMs,
    });

    expect(
      getProviderHealthTelegramDecision({
        provider: "pinnacle",
        alert: downAlert(),
        nowMs: nowMs + cooldownMs + 1,
        cooldownMs,
      }),
    ).toBe("down");
  });

  it("sends recovery once after a down alert", () => {
    getProviderHealthTelegramDecision({
      provider: "pinnacle",
      alert: downAlert(),
      nowMs,
      cooldownMs,
    });

    expect(
      getProviderHealthTelegramDecision({
        provider: "pinnacle",
        alert: null,
        nowMs: nowMs + 1_000,
        cooldownMs,
      }),
    ).toBe("recovered");

    expect(
      getProviderHealthTelegramDecision({
        provider: "pinnacle",
        alert: null,
        nowMs: nowMs + 2_000,
        cooldownMs,
      }),
    ).toBeNull();
  });

  it("suppresses changed down fingerprints within provider cooldown", () => {
    getProviderHealthTelegramDecision({
      provider: "pinnacle",
      alert: downAlert("pinnacle|down|down|first|never"),
      nowMs,
      cooldownMs,
    });

    expect(
      getProviderHealthTelegramDecision({
        provider: "pinnacle",
        alert: downAlert("pinnacle|down|down|second|never"),
        nowMs: nowMs + 60_000,
        cooldownMs,
      }),
    ).toBeNull();
  });

  it("does not send provider health Telegram events when the dashboard switch is off", async () => {
    vi.mocked(isProviderHealthTelegramEnabled).mockReturnValue(false);

    await notifyProviderHealthTransitions([downAlert()], new Date(nowMs));
    await notifyProviderHealthTransitions([], new Date(nowMs + 1_000));

    expect(notify).not.toHaveBeenCalled();

    vi.mocked(isProviderHealthTelegramEnabled).mockReturnValue(true);
    await notifyProviderHealthTransitions([], new Date(nowMs + 2_000));

    expect(notify).not.toHaveBeenCalled();
  });

  it("sends provider health Telegram events when the dashboard switch is on", async () => {
    await notifyProviderHealthTransitions([downAlert()], new Date(nowMs));

    expect(notify).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notify).mock.calls[0][0]).toMatchObject({
      type: "provider:health",
      state: "down",
      provider: "pinnacle",
    });
  });
});
