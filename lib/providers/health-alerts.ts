import type { ProviderStatus } from "../store";
import type { ProviderKey, ProviderMetadata } from "./registry";
import {
  PROVIDER_HEALTH_DEGRADED_AFTER_MS,
  PROVIDER_HEALTH_FAILURES_DOWN,
} from "../shared/constants";

export type ProviderAlertSeverity = "degraded" | "down";
export type ProviderAlertStatus = "pending" | "degraded" | "down" | "ok";

export interface ProviderRuntimeSnapshot {
  enabled: boolean;
  kind: string;
  platform: string | null;
  status: string;
  lastFetch: string | null;
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
  lastErrorAt?: string | null;
  unhealthySinceAt?: string | null;
  error: string | null;
  lastError?: string | null;
  consecutiveFailures?: number;
  connected: boolean | null;
  activeEvents: number | null;
  pendingRequests: number | null;
  circuitBreaker: { state: string; failures: number } | null;
}

export interface ProviderAlert {
  provider: ProviderKey;
  displayName: string;
  severity: ProviderAlertSeverity;
  status: ProviderAlertStatus;
  reason: string;
  action: string;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  fingerprint: string;
}

export interface ProviderHealthSignal {
  provider: ProviderKey;
  meta: ProviderMetadata;
  enabled: boolean;
  status: ProviderStatus;
  circuitBreaker?: { state: string; failures: number } | null;
  connected?: boolean | null;
  activeEvents?: number | null;
  firstSyncCompletedAt?: Date | string | null;
  nowMs?: number;
}

export const PROVIDER_ALERT_DISMISS_STORAGE_KEY =
  "provider-health-dismissed-fingerprints";

export function getProviderHealthAction(provider: ProviderKey): string {
  if (
    provider === "ninewickets-exchange" ||
    provider === "ninewickets-sportsbook" ||
    provider === "velki-sportsbook"
  ) {
    return "Check Bangladesh VPN/network; this provider requires Bangladesh IP.";
  }
  return "Check provider credentials, network path, and engine logs.";
}

export function formatProviderAlertFingerprint(input: {
  provider: string;
  severity: ProviderAlertSeverity;
  status: ProviderAlertStatus;
  reason: string;
  lastSuccessAt: string | null;
}): string {
  return [
    input.provider,
    input.severity,
    input.status,
    normalizeFingerprintPart(input.reason),
    input.lastSuccessAt ?? "never",
  ].join("|");
}

export function parseDismissedProviderAlertFingerprints(
  raw: string | null | undefined,
): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((item): item is string => typeof item === "string"),
    );
  } catch {
    return new Set();
  }
}

export function serializeDismissedProviderAlertFingerprints(
  values: Iterable<string>,
): string {
  return JSON.stringify(Array.from(new Set(values)).sort());
}

export function filterDismissedProviderAlerts(
  alerts: readonly ProviderAlert[],
  dismissedFingerprints: Iterable<string>,
): ProviderAlert[] {
  const dismissed = new Set(dismissedFingerprints);
  return alerts.filter((alert) => !dismissed.has(alert.fingerprint));
}

export function evaluateProviderHealthAlert(
  signal: ProviderHealthSignal,
): ProviderAlert | null {
  if (!signal.enabled) return null;

  const nowMs = signal.nowMs ?? Date.now();
  const firstSyncMs = toMs(signal.firstSyncCompletedAt);
  const lastSuccessMs = toMs(signal.status.lastSuccessAt);
  const lastErrorMs = toMs(signal.status.lastErrorAt);
  const lastAttemptMs = toMs(
    signal.status.lastAttemptAt ?? signal.status.lastFetch,
  );
  const unhealthySinceMs =
    toMs(signal.status.unhealthySinceAt) ?? lastErrorMs ?? lastAttemptMs;
  const consecutiveFailures = Math.max(
    0,
    signal.status.consecutiveFailures ?? 0,
  );
  const cbState = signal.circuitBreaker?.state ?? "closed";

  let severity: ProviderAlertSeverity | null = null;
  let reason: string | null = null;

  if (
    firstSyncMs === null &&
    lastAttemptMs === null &&
    lastSuccessMs === null &&
    consecutiveFailures === 0 &&
    cbState === "closed"
  ) {
    return null;
  }

  if (cbState === "open") {
    severity = "down";
    reason = "circuit breaker is open";
  } else if (
    consecutiveFailures >= PROVIDER_HEALTH_FAILURES_DOWN &&
    hasBeenUnhealthyForDegradedWindow(unhealthySinceMs, nowMs)
  ) {
    severity = "down";
    reason = "3+ consecutive fixture fetch failures";
  } else if (
    cbState === "half-open" &&
    hasBeenUnhealthyForDegradedWindow(unhealthySinceMs, nowMs)
  ) {
    severity = "degraded";
    reason = "circuit breaker is half-open";
  } else if (
    (consecutiveFailures > 0 || signal.status.status === "error") &&
    hasBeenUnhealthyForDegradedWindow(unhealthySinceMs, nowMs)
  ) {
    severity = "degraded";
    reason =
      signal.status.lastError ||
      signal.status.error ||
      "recent fixture fetch failure";
  } else if (
    firstSyncMs !== null &&
    lastAttemptMs === null &&
    hasBeenUnhealthyForDegradedWindow(firstSyncMs, nowMs)
  ) {
    severity = "degraded";
    reason = "waiting for first provider check";
  } else if (
    firstSyncMs !== null &&
    lastSuccessMs === null &&
    hasBeenUnhealthyForDegradedWindow(firstSyncMs, nowMs)
  ) {
    severity = "degraded";
    reason = "no successful data for 15 minutes after first sync";
  } else if (
    lastSuccessMs !== null &&
    hasBeenUnhealthyForDegradedWindow(lastSuccessMs, nowMs)
  ) {
    severity = "degraded";
    reason = "provider data is stale";
  } else if (
    signal.connected === false &&
    connectionMatters(signal) &&
    hasBeenUnhealthyForDegradedWindow(
      unhealthySinceMs ?? lastSuccessMs ?? firstSyncMs,
      nowMs,
    )
  ) {
    severity = "degraded";
    reason = "live connection is disconnected or reconnecting";
  }

  if (!severity || !reason) return null;

  const lastSuccessAt = toIso(signal.status.lastSuccessAt);
  const status: ProviderAlertStatus = severity;
  const alertBase = {
    provider: signal.provider,
    displayName: signal.meta.displayName,
    severity,
    status,
    reason,
    action: getProviderHealthAction(signal.provider),
    lastSuccessAt,
    consecutiveFailures,
  };

  return {
    ...alertBase,
    fingerprint: formatProviderAlertFingerprint(alertBase),
  };
}

export function buildProviderAlerts(
  signals: readonly ProviderHealthSignal[],
): ProviderAlert[] {
  return signals
    .map((signal) => evaluateProviderHealthAlert(signal))
    .filter((alert): alert is ProviderAlert => alert !== null)
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

function severityRank(severity: ProviderAlertSeverity): number {
  return severity === "down" ? 2 : 1;
}

function hasBeenUnhealthyForDegradedWindow(
  unhealthySinceMs: number | null,
  nowMs: number,
): boolean {
  return (
    unhealthySinceMs !== null &&
    nowMs - unhealthySinceMs >= PROVIDER_HEALTH_DEGRADED_AFTER_MS
  );
}

function connectionMatters(signal: ProviderHealthSignal): boolean {
  return (
    signal.meta.integration.kind === "websocket" ||
    (signal.activeEvents ?? 0) > 0
  );
}

function toMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeFingerprintPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}
