/**
 * HTTP client for the entity-matcher Cloud Run Service.
 *
 * Replaces the LightGBM `classifier.ts` client. Talks to the FastAPI app
 * at `ENTITY_MATCHER_URL` exposing /embed, /score (bi-encoder | cross-encoder),
 * and /reload.
 *
 * Auth: the Cloud Run service requires IAM auth (`--no-allow-unauthenticated`).
 * We use `google-auth-library` to obtain an ID token with the service URL as
 * audience — same ADC pattern the optimizer client uses.
 *
 * Failure mode: every call returns `null` on timeout or non-2xx. The
 * auto-resolver treats `null` as "model unavailable → escalate to operator
 * inbox". The sync hot path never throws because of a matcher outage.
 */

import { GoogleAuth } from "google-auth-library";
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

let _auth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (_auth) return _auth;
  _auth = new GoogleAuth();
  return _auth;
}

export async function getIdToken(): Promise<string | null> {
  const audience = baseUrl();
  if (!audience) return null;
  try {
    const client = await getAuth().getIdTokenClient(audience);
    const hdrs = await client.getRequestHeaders();
    let authHeader: string | null | undefined = null;

    // google-auth-library might return a Headers instance or a plain object
    if (typeof hdrs.get === "function") {
      authHeader = hdrs.get("authorization") ?? hdrs.get("Authorization");
    } else {
      const record = hdrs as unknown as Record<string, string>;
      authHeader = record.authorization ?? record.Authorization;
    }

    return authHeader?.replace("Bearer ", "") ?? null;
  } catch (err) {
    logger.warn(tag, `Failed to get ID token: ${(err as Error).message}`);
    return null;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getIdToken();
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
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
    const headers = await authHeaders();
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers,
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

// ── HF Serverless Inference API (primary embedding provider) ────────

const HF_INFERENCE_URL = "https://router.huggingface.co/hf-inference/models";

/**
 * Embed texts via HF Serverless Inference API (hf-inference provider).
 * Free tier: ~300 req/hour, rate-based (no credits consumed).
 * Returns null on any failure — caller falls through to Cloud Run.
 */
async function embedViaHF(
  texts: string[],
): Promise<number[][] | null> {
  const token = process.env.HF_API_KEY;
  const model = process.env.HF_EMBED_MODEL || "BAAI/bge-m3";
  if (!token) return null;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000); // 30s for cold starts
    try {
      const res = await fetch(`${HF_INFERENCE_URL}/${model}/pipeline/feature-extraction`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: texts }),
        signal: ctrl.signal,
      });

      if (res.status === 429 || res.status === 503) {
        logger.debug(tag, `HF embed ${res.status} — falling back to Cloud Run`);
        return null;
      }
      if (!res.ok) {
        logger.warn(tag, `HF embed returned ${res.status}`);
        return null;
      }

      const vectors = (await res.json()) as number[][];
      if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        logger.warn(tag, `HF embed returned wrong shape: ${vectors?.length} vs ${texts.length}`);
        return null;
      }
      // Validate first vector dimension
      if (vectors[0] && vectors[0].length !== EMBEDDING_DIM) {
        logger.warn(tag, `HF embed dim mismatch: ${vectors[0].length} vs ${EMBEDDING_DIM}`);
        return null;
      }
      return vectors;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      logger.debug(tag, `HF embed failed: ${(err as Error).message}`);
    }
    return null;
  }
}

/**
 * Embed a single surface form. Returns a 1024-dim vector or null if the
 * matcher service is unreachable or returns the wrong shape.
 */
export async function embed(text: string): Promise<number[] | null> {
  // Try HF Serverless first
  const hfResult = await embedViaHF([text]);
  if (hfResult?.[0] && hfResult[0].length === EMBEDDING_DIM) {
    return hfResult[0];
  }
  // Fallback: Cloud Run
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
 * Batch-embed a list of surface forms. Returns a Map from each input text
 * to its 1024-dim BGE-M3 embedding vector, or null if the service is
 * unreachable.
 *
 * Used by the ML pair scorer to embed all unique team/competition names
 * from a batch of match pairs in a single round-trip (~100ms for 150
 * names), then compute cosine similarities locally.
 *
 * The /embed-batch endpoint accepts `{ texts: string[] }` and returns
 * `{ embeddings: number[][] }` in the same order.
 */
export async function embedBatch(
  texts: string[],
): Promise<Map<string, number[]> | null> {
  if (texts.length === 0) return new Map();

  const deduped = [...new Set(texts)];

  // ── Primary: HF Serverless Inference API (free, ~300 RPH) ──
  const hfVectors = await embedViaHF(deduped);
  if (hfVectors && hfVectors.length === deduped.length) {
    const map = new Map<string, number[]>();
    for (let i = 0; i < deduped.length; i++) {
      const vec = hfVectors[i];
      if (vec && vec.length === EMBEDDING_DIM) {
        map.set(deduped[i], vec);
      }
    }
    if (map.size === deduped.length) return map;
    // Some vectors had wrong dim — fall through to Cloud Run
  }

  // ── Fallback: Cloud Run entity-matcher (self-hosted BGE-M3) ──
  const out = await postJson<{ embeddings?: number[][] }>(
    "/embed-batch",
    { texts: deduped },
    Math.max(15_000, deduped.length * 20 + 2000),
  );
  if (!out?.embeddings || out.embeddings.length !== deduped.length) {
    return null;
  }

  const map = new Map<string, number[]>();
  for (let i = 0; i < deduped.length; i++) {
    const vec = out.embeddings[i];
    if (vec && vec.length === EMBEDDING_DIM) {
      map.set(deduped[i], vec);
    }
  }
  return map;
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
    const headers = await authHeaders();
    const res = await fetch(`${base}/healthz`, {
      headers,
      signal: ctrl.signal,
    });
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
