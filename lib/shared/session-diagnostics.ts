/**
 * Session Diagnostics Store
 *
 * Tracks per-provider, per-step capture diagnostics so operators can
 * see at a glance which step of the multi-step auth flow is failing,
 * why, and when. Surfaced via the engine health endpoint.
 *
 * Providers:
 *   - ninewickets: CF-solve → login → getGameUrl → process
 *   - velki:       login → game-launch → jsessionid
 *   - pinnacle:    CF-solve → login → getGameUrl → process
 */

import { singleton } from "../util/singleton";

export interface StepDiagnostic {
  step: string;
  status: "ok" | "failed" | "pending";
  durationMs?: number;
  error?: string;
  at: string;
}

export interface ProviderSessionDiagnostics {
  /** Provider identifier (e.g. "velki-sportsbook", "ninewickets-sportsbook"). */
  provider: string;
  /** The steps from the last capture attempt, in order. */
  steps: StepDiagnostic[];
  /** Overall status of the last capture. */
  lastCaptureStatus: "ok" | "failed" | "pending" | "idle";
  /** When the last capture started. */
  lastCaptureAt: string | null;
  /** How many consecutive failures. */
  consecutiveFailures: number;
  /** Total capture attempts since engine start. */
  totalAttempts: number;
}

// HMR-safe global store
const store = singleton("session-diagnostics", () => ({
  providers: new Map<string, ProviderSessionDiagnostics>(),
}));

const MAX_STEPS_PER_PROVIDER = 20;

function getOrCreate(providerId: string): ProviderSessionDiagnostics {
  let d = store.providers.get(providerId);
  if (!d) {
    d = {
      provider: providerId,
      steps: [],
      lastCaptureStatus: "idle",
      lastCaptureAt: null,
      consecutiveFailures: 0,
      totalAttempts: 0,
    };
    store.providers.set(providerId, d);
  }
  return d;
}

/** Call at the start of a capture attempt. Resets steps. */
export function captureStarted(providerId: string): void {
  const d = getOrCreate(providerId);
  d.steps = [];
  d.lastCaptureStatus = "pending";
  d.lastCaptureAt = new Date().toISOString();
  d.totalAttempts++;

  // Cap total providers tracked to prevent unbounded map growth
  if (store.providers.size > 50) {
    const oldest = store.providers.keys().next().value;
    if (oldest && oldest !== providerId) store.providers.delete(oldest);
  }
}

/** Record a step completion. */
export function stepCompleted(
  providerId: string,
  step: string,
  durationMs: number,
): void {
  const d = getOrCreate(providerId);
  d.steps.push({
    step,
    status: "ok",
    durationMs,
    at: new Date().toISOString(),
  });
  if (d.steps.length > MAX_STEPS_PER_PROVIDER) {
    d.steps.splice(0, d.steps.length - MAX_STEPS_PER_PROVIDER);
  }
}

/** Record a step failure. */
export function stepFailed(
  providerId: string,
  step: string,
  error: string,
  durationMs?: number,
): void {
  const d = getOrCreate(providerId);
  d.steps.push({
    step,
    status: "failed",
    error,
    durationMs,
    at: new Date().toISOString(),
  });
  if (d.steps.length > MAX_STEPS_PER_PROVIDER) {
    d.steps.splice(0, d.steps.length - MAX_STEPS_PER_PROVIDER);
  }
  d.lastCaptureStatus = "failed";
  d.consecutiveFailures++;
}

/** Call when the full capture succeeds. */
export function captureSucceeded(providerId: string): void {
  const d = getOrCreate(providerId);
  d.lastCaptureStatus = "ok";
  d.consecutiveFailures = 0;
}

/** Call when the full capture fails (after all retries). */
export function captureFailed(providerId: string, error: string): void {
  const d = getOrCreate(providerId);
  d.lastCaptureStatus = "failed";
  // Keep consecutiveFailures from stepFailed calls
  // Ensure there's at least a failure record
  if (d.steps.length === 0 || d.steps[d.steps.length - 1].status !== "failed") {
    d.steps.push({
      step: "overall",
      status: "failed",
      error,
      at: new Date().toISOString(),
    });
  }
}

/** Get diagnostics for a single provider. */
export function getSessionDiagnostics(
  providerId: string,
): ProviderSessionDiagnostics | null {
  return store.providers.get(providerId) ?? null;
}

/** Get diagnostics for all providers. */
export function getAllSessionDiagnostics(): Record<
  string,
  ProviderSessionDiagnostics
> {
  const result: Record<string, ProviderSessionDiagnostics> = {};
  for (const [id, d] of store.providers) {
    result[id] = d;
  }
  return result;
}
