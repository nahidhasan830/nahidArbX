/**
 * Entity Matcher Client - Vertex AI Embeddings
 *
 * Generates embeddings for entity matching using Vertex AI's managed
 * text-embedding models. The old self-hosted Python matcher fallback has
 * been removed; unavailable Vertex embeddings return null.
 */

import {
  embedBatch as vertexEmbedBatch,
  embed as vertexEmbed,
  cosineSimilarity,
  EMBEDDING_DIM as VERTEX_EMBEDDING_DIM,
} from "./vertex-embeddings-client";

export const EMBEDDING_DIM = VERTEX_EMBEDDING_DIM;

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

/**
 * Embed a single surface form. Returns a 768-dim vector or null on failure.
 */
export async function embed(text: string): Promise<number[] | null> {
  return vertexEmbed(text);
}

/**
 * Bi-encoder cosine similarity in [0, 1]. Returns null when Vertex
 * embeddings are unavailable so callers can escalate safely.
 */
export async function scoreBiEncoder(
  nameA: string,
  nameB: string,
  context?: ScoreContext,
): Promise<number | null> {
  void context;
  const [embA, embB] = await Promise.all([
    vertexEmbed(nameA),
    vertexEmbed(nameB),
  ]);

  if (!embA || !embB) return null;
  return (cosineSimilarity(embA, embB) + 1) / 2;
}

/**
 * Cross-encoder calibration was provided by the removed Python service.
 * Keep the typed API so existing entity auto-resolver stages degrade to
 * operator review without throwing.
 */
export async function scoreCrossEncoder(
  nameA: string,
  nameB: string,
  context?: ScoreContext,
): Promise<MatcherScore | null> {
  void nameA;
  void nameB;
  void context;
  return null;
}

/**
 * Batch-embed a list of surface forms. Returns a Map from each input text
 * to its 768-dim embedding vector, or null if any embedding fails.
 */
export async function embedBatch(
  texts: string[],
): Promise<Map<string, number[]> | null> {
  if (texts.length === 0) return new Map();

  const deduped = [...new Set(texts)];
  const vertexResults = await vertexEmbedBatch(deduped);
  const allValid = vertexResults.every((r) => r !== null);
  if (!allValid) return null;

  const map = new Map<string, number[]>();
  for (let i = 0; i < deduped.length; i++) {
    map.set(deduped[i], vertexResults[i]!);
  }
  return map;
}

export async function checkHealthz(): Promise<{
  ok: boolean;
  calibrator_version?: string;
} | null> {
  return null;
}

export async function reloadCalibrator(): Promise<{
  reloaded: boolean;
  calibrator_version: string;
} | null> {
  return null;
}
