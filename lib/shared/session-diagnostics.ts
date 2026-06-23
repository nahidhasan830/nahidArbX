
import { singleton } from "../util/singleton";

export interface StepDiagnostic {
  step: string;
  status: "ok" | "failed" | "pending";
  durationMs?: number;
  error?: string;
  at: string;
}

export interface ProviderSessionDiagnostics {
  provider: string;
  steps: StepDiagnostic[];
  lastCaptureStatus: "ok" | "failed" | "pending" | "idle";
  lastCaptureAt: string | null;
  consecutiveFailures: number;
  totalAttempts: number;
}

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

export function captureStarted(providerId: string): void {
  const d = getOrCreate(providerId);
  d.steps = [];
  d.lastCaptureStatus = "pending";
  d.lastCaptureAt = new Date().toISOString();
  d.totalAttempts++;

  if (store.providers.size > 50) {
    const oldest = store.providers.keys().next().value;
    if (oldest && oldest !== providerId) store.providers.delete(oldest);
  }
}

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

export function captureSucceeded(providerId: string): void {
  const d = getOrCreate(providerId);
  d.lastCaptureStatus = "ok";
  d.consecutiveFailures = 0;
}

export function captureFailed(providerId: string, error: string): void {
  const d = getOrCreate(providerId);
  d.lastCaptureStatus = "failed";
  if (d.steps.length === 0 || d.steps[d.steps.length - 1].status !== "failed") {
    d.steps.push({
      step: "overall",
      status: "failed",
      error,
      at: new Date().toISOString(),
    });
  }
}

export function getSessionDiagnostics(
  providerId: string,
): ProviderSessionDiagnostics | null {
  return store.providers.get(providerId) ?? null;
}

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
