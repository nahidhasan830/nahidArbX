import { describe, expect, it } from "vitest";
import {
  evaluateProviderHealthAlert,
  filterDismissedProviderAlerts,
  formatProviderAlertFingerprint,
  parseDismissedProviderAlertFingerprints,
  serializeDismissedProviderAlertFingerprints,
  type ProviderAlert,
} from "@/lib/providers/health-alerts";
import {
  PROVIDER_HEALTH_FAILURES_DOWN,
  PROVIDER_HEALTH_STALE_MS,
} from "@/lib/shared/constants";
import { PROVIDER_REGISTRY, type ProviderKey } from "@/lib/providers/registry";
import type { ProviderStatus } from "@/lib/store";

const baseTime = Date.parse("2026-06-04T12:00:00.000Z");

function status(overrides: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    status: "pending",
    lastFetch: null,
    error: undefined,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    consecutiveFailures: 0,
    lastError: undefined,
    ...overrides,
  };
}

function alertFor(
  provider: ProviderKey,
  overrides: Partial<ProviderStatus> & {
    enabled?: boolean;
    firstSyncCompletedAt?: Date | null;
    circuitBreaker?: { state: string; failures: number } | null;
    connected?: boolean | null;
    activeEvents?: number | null;
  } = {},
) {
  return evaluateProviderHealthAlert({
    provider,
    meta: PROVIDER_REGISTRY[provider],
    enabled: overrides.enabled ?? true,
    status: status(overrides),
    circuitBreaker: overrides.circuitBreaker ?? null,
    connected: overrides.connected ?? null,
    activeEvents: overrides.activeEvents ?? null,
    firstSyncCompletedAt: overrides.firstSyncCompletedAt ?? null,
    nowMs: baseTime,
  });
}

describe("provider health classification", () => {
  it("does not alert during pending startup before first meaningful check", () => {
    expect(alertFor("pinnacle")).toBeNull();
  });

  it("marks a recent single failure as degraded", () => {
    const alert = alertFor("ninewickets-sportsbook", {
      status: "error",
      lastAttemptAt: new Date(baseTime - 10_000),
      lastErrorAt: new Date(baseTime - 10_000),
      consecutiveFailures: 1,
      error: "HTTP 403",
    });

    expect(alert?.severity).toBe("degraded");
    expect(alert?.reason).toBe("HTTP 403");
    expect(alert?.action).toContain("Bangladesh VPN/network");
  });

  it("marks three consecutive failures as down", () => {
    const alert = alertFor("velki-sportsbook", {
      status: "error",
      lastAttemptAt: new Date(baseTime - 10_000),
      lastErrorAt: new Date(baseTime - 10_000),
      consecutiveFailures: PROVIDER_HEALTH_FAILURES_DOWN,
      error: "timeout",
    });

    expect(alert?.severity).toBe("down");
    expect(alert?.reason).toBe("3+ consecutive fixture fetch failures");
  });

  it("marks an open circuit breaker as down", () => {
    const alert = alertFor("pinnacle", {
      status: "ok",
      lastSuccessAt: new Date(baseTime - 30_000),
      circuitBreaker: { state: "open", failures: 3 },
    });

    expect(alert?.severity).toBe("down");
    expect(alert?.reason).toBe("circuit breaker is open");
  });

  it("ignores disabled providers", () => {
    expect(
      alertFor("saba-sportsbook", {
        enabled: false,
        status: "error",
        consecutiveFailures: 10,
      }),
    ).toBeNull();
  });

  it("marks no successful data after first sync as down after the stale window", () => {
    const alert = alertFor("ninewickets-exchange", {
      firstSyncCompletedAt: new Date(baseTime - PROVIDER_HEALTH_STALE_MS - 1),
      lastAttemptAt: new Date(baseTime - PROVIDER_HEALTH_STALE_MS),
    });

    expect(alert?.severity).toBe("down");
    expect(alert?.reason).toBe(
      "no successful data more than 5 minutes after first sync",
    );
  });

  it("clears the alert after recovery", () => {
    expect(
      alertFor("ninewickets-sportsbook", {
        status: "ok",
        lastAttemptAt: new Date(baseTime - 5_000),
        lastSuccessAt: new Date(baseTime - 5_000),
        consecutiveFailures: 0,
      }),
    ).toBeNull();
  });
});

describe("provider alert fingerprints and dismissal", () => {
  it("changes fingerprint when recovery-relevant state changes", () => {
    const first = formatProviderAlertFingerprint({
      provider: "pinnacle",
      severity: "down",
      status: "down",
      reason: "circuit breaker is open",
      lastSuccessAt: "2026-06-04T11:00:00.000Z",
    });
    const second = formatProviderAlertFingerprint({
      provider: "pinnacle",
      severity: "degraded",
      status: "degraded",
      reason: "circuit breaker is half-open",
      lastSuccessAt: "2026-06-04T11:00:00.000Z",
    });

    expect(first).not.toBe(second);
  });

  it("parses, serializes, and filters dismissed alert fingerprints", () => {
    const alert = {
      provider: "pinnacle",
      displayName: "Pinnacle",
      severity: "down",
      status: "down",
      reason: "circuit breaker is open",
      action: "Check provider credentials, network path, and engine logs.",
      lastSuccessAt: null,
      consecutiveFailures: 3,
      fingerprint: "pinnacle|down|down|circuit-breaker-is-open|never",
    } satisfies ProviderAlert;

    const serialized = serializeDismissedProviderAlertFingerprints([
      alert.fingerprint,
      alert.fingerprint,
    ]);
    const parsed = parseDismissedProviderAlertFingerprints(serialized);

    expect(parsed.has(alert.fingerprint)).toBe(true);
    expect(filterDismissedProviderAlerts([alert], parsed)).toEqual([]);
    expect(parseDismissedProviderAlertFingerprints("not-json")).toEqual(
      new Set(),
    );
  });
});
