/**
 * Bulk-run control for /api/match-review/analyze-stream.
 *
 * One active bulk session at a time. The analyze-stream handler starts a
 * session, the worker loop checks these flags on each iteration, and
 * subscribers (the bulk-stream SSE endpoint) get live events so reconnecting
 * clients don't lose visibility on a refresh.
 *
 * Server-only — lives in module scope, not persisted. Single Node process
 * only; a clustered deployment would need Redis or similar.
 */

export type BulkEvent =
  | {
      type: "start";
      sessionId: string;
      model: string;
      total: number;
      startedAt: number;
    }
  | {
      type: "progress";
      done: number;
      total: number;
      analyzed: number;
      cached: number;
      errored: number;
    }
  | {
      type: "result";
      index: number;
      status: "analyzed" | "cached" | "error";
      // Pass-through of the analyzeOne result; kept opaque here so control
      // doesn't depend on cache types.
      payload: unknown;
    }
  | {
      type: "log";
      tone: "info" | "warning" | "error" | "success";
      text: string;
    }
  | { type: "paused" }
  | { type: "resumed" }
  | { type: "aborted" }
  | {
      type: "done";
      analyzed: number;
      cached: number;
      errored: number;
      total: number;
      aborted: boolean;
    }
  // Transport-only marker sent by the SSE route after it finishes replaying
  // the buffered events, before tailing live ones. Clients use this to tell
  // historical events (no user notifications) from live ones (toast on done).
  | { type: "hydrated" };

interface BulkControlState {
  active: boolean;
  aborted: boolean;
  paused: boolean;
  sessionId: string;
  model: string | null;
  total: number;
  done: number;
  analyzed: number;
  cached: number;
  errored: number;
  startedAt: number;
  endedAt: number;
  // Recent events for late subscribers (SSE reconnect after refresh).
  buffer: BulkEvent[];
  // Listeners attached by the SSE endpoint.
  listeners: Set<(evt: BulkEvent) => void>;
  // Resolves the current waitIfPaused() promise so workers can proceed.
  resumeFn: (() => void) | null;
}

const BUFFER_CAP = 300;

// Versioned key — bump the suffix whenever the state shape changes so a hot
// reload in dev doesn't keep a stale object with missing fields (which would
// silently crash subscribers and leave zombie `active: true` flags).
declare global {
  var __bulkControlStateV2: BulkControlState | undefined;
}

function freshState(): BulkControlState {
  return {
    active: false,
    aborted: false,
    paused: false,
    sessionId: "",
    model: null,
    total: 0,
    done: 0,
    analyzed: 0,
    cached: 0,
    errored: 0,
    startedAt: 0,
    endedAt: 0,
    buffer: [],
    listeners: new Set(),
    resumeFn: null,
  };
}

function getState(): BulkControlState {
  if (!globalThis.__bulkControlStateV2) {
    globalThis.__bulkControlStateV2 = freshState();
  }
  return globalThis.__bulkControlStateV2;
}

function emit(evt: BulkEvent): void {
  const s = getState();
  s.buffer.push(evt);
  if (s.buffer.length > BUFFER_CAP) {
    s.buffer.splice(0, s.buffer.length - BUFFER_CAP);
  }
  for (const fn of s.listeners) {
    try {
      fn(evt);
    } catch {
      // A listener throw shouldn't take down the worker loop.
    }
  }
}

export function beginSession(model: string, total: number): string {
  const s = getState();
  const sessionId = `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  s.active = true;
  s.aborted = false;
  s.paused = false;
  s.sessionId = sessionId;
  s.model = model;
  s.total = total;
  s.done = 0;
  s.analyzed = 0;
  s.cached = 0;
  s.errored = 0;
  s.startedAt = Date.now();
  s.endedAt = 0;
  s.buffer = [];
  s.resumeFn = null;
  emit({
    type: "start",
    sessionId,
    model,
    total,
    startedAt: s.startedAt,
  });
  return sessionId;
}

export function endSession(): void {
  const s = getState();
  if (!s.active) return;
  emit({
    type: "done",
    analyzed: s.analyzed,
    cached: s.cached,
    errored: s.errored,
    total: s.total,
    aborted: s.aborted,
  });
  s.active = false;
  s.endedAt = Date.now();
  s.paused = false;
  if (s.resumeFn) {
    s.resumeFn();
    s.resumeFn = null;
  }
}

export function recordResult(
  index: number,
  status: "analyzed" | "cached" | "error",
  payload: unknown,
): void {
  const s = getState();
  if (status === "analyzed") s.analyzed++;
  else if (status === "cached") s.cached++;
  else s.errored++;
  s.done++;
  emit({ type: "result", index, status, payload });
  emit({
    type: "progress",
    done: s.done,
    total: s.total,
    analyzed: s.analyzed,
    cached: s.cached,
    errored: s.errored,
  });
}

export function logEvent(
  tone: "info" | "warning" | "error" | "success",
  text: string,
): void {
  emit({ type: "log", tone, text });
}

export function abort(): void {
  const s = getState();
  if (!s.active) return;
  s.aborted = true;
  emit({ type: "aborted" });
  // If paused, release so the worker can see the abort flag and exit.
  if (s.resumeFn) {
    s.resumeFn();
    s.resumeFn = null;
  }
  s.paused = false;
}

export function pause(): void {
  const s = getState();
  if (s.active && !s.paused && !s.aborted) {
    s.paused = true;
    emit({ type: "paused" });
  }
}

export function resume(): void {
  const s = getState();
  if (s.paused) {
    s.paused = false;
    emit({ type: "resumed" });
    if (s.resumeFn) {
      s.resumeFn();
      s.resumeFn = null;
    }
  }
}

export function isAborted(): boolean {
  return getState().aborted;
}

export function isPaused(): boolean {
  return getState().paused;
}

export interface BulkStatus {
  active: boolean;
  aborted: boolean;
  paused: boolean;
  sessionId: string;
  model: string | null;
  total: number;
  done: number;
  analyzed: number;
  cached: number;
  errored: number;
  startedAt: number;
  endedAt: number;
}

export function getStatus(): BulkStatus {
  const s = getState();
  return {
    active: s.active,
    aborted: s.aborted,
    paused: s.paused,
    sessionId: s.sessionId,
    model: s.model,
    total: s.total,
    done: s.done,
    analyzed: s.analyzed,
    cached: s.cached,
    errored: s.errored,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
  };
}

/** Snapshot of the recent event buffer — used by late SSE subscribers. */
export function getBuffer(): BulkEvent[] {
  return [...getState().buffer];
}

export function subscribe(listener: (evt: BulkEvent) => void): () => void {
  const s = getState();
  s.listeners.add(listener);
  return () => {
    s.listeners.delete(listener);
  };
}

/**
 * Awaits until the session is resumed or aborted. Returns immediately if
 * not paused. Safe to call repeatedly from multiple workers.
 */
export function waitIfPaused(): Promise<void> {
  const s = getState();
  if (!s.paused || s.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const prev = s.resumeFn;
    s.resumeFn = () => {
      if (prev) prev();
      resolve();
    };
  });
}
