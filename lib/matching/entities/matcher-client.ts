/**
 * HTTP client for the entity-matcher Cloud Run Service.
 *
 * Replaces the LightGBM `classifier.ts` client. Talks to the FastAPI app
 * at `ENTITY_MATCHER_URL` exposing /embed, /score (bi-encoder | cross-encoder),
 * and /reload.
 *
 * Failure mode: every call returns `null` on timeout or non-2xx. The
 * auto-resolver treats `null` as "model unavailable → escalate to operator
 * inbox". The sync hot path never throws because of a matcher outage.
 */

import { logger } from "../../shared/logger";

const tag = "EntityMatcherClient";

// 1.5 s timeout matches the previous classifier client. Bi-encoder calls
// finish in ~50 ms; cross-encoder in ~150 ms — 1.5 s leaves headroom for
// cold starts on the matcher service.
const TIMEOUT_MS = 1500;

export const EMBEDDING_DIM = 1024;

export interface MatcherScore {
  score: number;
  pvalue: number | null;
  stage_used: "bi-encoder" | "cross-encoder";
  model_version: string;
}

interface ScoreContext {
  provider?: string;
  competition_canonical?: string;
}

function baseUrl(): string | null {
  const u = process.env.ENTITY_MATCHER_URL;
  if (!u) return null;
  return u.replace(/\/$/, "");
}

async function postJson<T>(
  path: string,
  body: unknown,
  timeoutMs = TIMEOUT_MS,
): Promise<T | null> {
  const base = baseUrl();
  if (!base) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logger.warn(tag, `${path} returned ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      logger.warn(tag, `${path} call failed: ${(err as Error).message}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Embed a single surface form. Returns a 1024-dim vector or null if the
 * matcher service is unreachable or returns the wrong shape.
 */
export async function embed(text: string): Promise<number[] | null> {
  const out = await postJson<{ embedding?: number[] }>("/embed", { text });
  if (!out?.embedding || out.embedding.length !== EMBEDDING_DIM) return null;
  return out.embedding;
}

/**
 * Bi-encoder cosine similarity in [0, 1]. Fast (~50 ms) — used as the
 * first stage of the auto-resolver to filter the easy cases before
 * burning cross-encoder cycles.
 *
 * Returns null on service failure (caller skips this stage and falls
 * through to the cross-encoder or operator inbox).
 */
export async function scoreBiEncoder(
  nameA: string,
  nameB: string,
  context?: ScoreContext,
): Promise<number | null> {
  const out = await postJson<MatcherScore>("/score", {
    name_a: nameA,
    name_b: nameB,
    stage: "bi-encoder",
    context,
  });
  return out ? out.score : null;
}

/**
 * Cross-encoder reranker + conformal calibration. Slower (~150 ms) but
 * vastly more accurate on hard pairs (e.g. two teams with similar names
 * in the same competition). Returns the calibrated score AND the conformal
 * p-value — auto-resolver promotes only when p ≤ 0.05.
 *
 * Returns null on service failure.
 */
export async function scoreCrossEncoder(
  nameA: string,
  nameB: string,
  context?: ScoreContext,
): Promise<MatcherScore | null> {
  return postJson<MatcherScore>("/score", {
    name_a: nameA,
    name_b: nameB,
    stage: "cross-encoder",
    context,
  });
}

/**
 * Probe whether the matcher service is reachable. Used by the calibration
 * monitor + the UI health pill. Caches via the caller — this is a raw
 * health check, no caching here.
 */
export async function checkHealthz(): Promise<{
  ok: boolean;
  calibrator_version?: string;
} | null> {
  const base = baseUrl();
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/healthz`, { signal: ctrl.signal });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { calibrator_version?: string };
    return { ok: true, calibrator_version: data.calibrator_version };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Trigger a calibrator hot-reload after the trainer Job publishes new
 * weights. Idempotent — the service re-reads the artefact from disk
 * without restarting the process.
 */
export async function reloadCalibrator(): Promise<{
  reloaded: boolean;
  calibrator_version: string;
} | null> {
  return postJson<{ reloaded: boolean; calibrator_version: string }>(
    "/reload",
    {},
  );
}
