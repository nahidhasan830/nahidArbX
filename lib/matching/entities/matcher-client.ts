/**
 * Entity Matcher Client — Vertex AI Embeddings
 *
 * Generates embeddings for entity matching using Vertex AI's managed
 * text-embedding models. Replaces self-hosted Hugging Face models.
 *
 * Fallback: if VERTEX_EMBEDDING_MODEL is not configured, falls back to
 * the Cloud Run entity-matcher service (if ENTITY_MATCHER_URL is set).
 *
 * Auth: Vertex AI uses ADC. Cloud Run service requires IAM auth.
 *
 * Failure mode: every call returns `null` on timeout or error. The
 * auto-resolver treats `null` as "model unavailable → escalate to operator
 * inbox". The sync hot path never throws because of a matcher outage.
 */

import { GoogleAuth } from "google-auth-library";
import { logger } from "../../shared/logger";
import {
  embedBatch as vertexEmbedBatch,
  embed as vertexEmbed,
  cosineSimilarity,
  EMBEDDING_DIM as VERTEX_EMBEDDING_DIM,
} from "./vertex-embeddings-client";

const tag = "EntityMatcherClient";

// 1.5 s timeout matches the previous classifier client. Vertex AI calls
// finish in ~100-200ms; 1.5s leaves headroom for cold starts.
const TIMEOUT_MS = 1500;

export const EMBEDDING_DIM = VERTEX_EMBEDDING_DIM; // 768 for text-embedding-004

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

/**
 * Embed a single surface form. Returns a 768-dim vector or null on failure.
 * Uses Vertex AI managed embeddings (primary) or Cloud Run service (fallback).
 */
export async function embed(text: string): Promise<number[] | null> {
  // Primary: Vertex AI managed embeddings
  const vertexResult = await vertexEmbed(text);
  if (vertexResult !== null) return vertexResult;

  // Fallback: Cloud Run entity-matcher service (if configured)
  const base = baseUrl();
  if (!base) return null;

  const out = await postJson<{ embedding?: number[] }>("/embed", { text });
  if (!out?.embedding || out.embedding.length !== EMBEDDING_DIM) return null;
  return out.embedding;
}

/**
 * Bi-encoder cosine similarity in [0, 1]. Fast (~100-200ms with Vertex AI).
 * Used as the first stage of the auto-resolver to filter easy cases.
 *
 * Returns null on service failure (caller skips this stage and falls
 * through to the cross-encoder or operator inbox).
 */
export async function scoreBiEncoder(
  nameA: string,
  nameB: string,
  context?: ScoreContext,
): Promise<number | null> {
  // Primary: Vertex AI embeddings + local cosine similarity
  const [embA, embB] = await Promise.all([
    vertexEmbed(nameA),
    vertexEmbed(nameB),
  ]);

  if (embA && embB) {
    const similarity = cosineSimilarity(embA, embB);
    // Convert from [-1, 1] to [0, 1] range
    return (similarity + 1) / 2;
  }

  // Fallback: Cloud Run entity-matcher service (if configured)
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
 * to its 768-dim embedding vector, or null on failure.
 *
 * Used by the ML pair scorer to embed all unique team/competition names
 * from a batch of match pairs in a single round-trip, then compute cosine
 * similarities locally.
 */
export async function embedBatch(
  texts: string[],
): Promise<Map<string, number[]> | null> {
  if (texts.length === 0) return new Map();

  const deduped = [...new Set(texts)];

  // Primary: Vertex AI managed embeddings
  const vertexResults = await vertexEmbedBatch(deduped);
  const allValid = vertexResults.every((r) => r !== null);

  if (allValid) {
    const map = new Map<string, number[]>();
    for (let i = 0; i < deduped.length; i++) {
      map.set(deduped[i], vertexResults[i]!);
    }
    return map;
  }

  // Fallback: Cloud Run entity-matcher service (if configured)
  const base = baseUrl();
  if (!base) return null;

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
