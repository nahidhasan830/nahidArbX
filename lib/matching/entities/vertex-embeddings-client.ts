/**
 * Vertex AI Text Embeddings Client
 *
 * Generates embeddings for entity matching using Vertex AI's text-embedding models.
 * Replaces self-hosted Hugging Face models with managed embeddings API.
 *
 * Uses the Vertex AI REST API directly since the Node.js SDK doesn't expose
 * the embeddings endpoint.
 *
 * Configuration (via .env):
 *   GCP_PROJECT_ID — GCP project ID (already configured)
 *   GCP_REGION — GCP region (already configured)
 *   VERTEX_EMBEDDING_MODEL — model name (default: text-embedding-004)
 *
 * Supported models:
 *   - text-embedding-004 (latest, 768 dims, multilingual)
 *   - text-multilingual-embedding-002 (768 dims, 100+ languages)
 *   - textembedding-gecko@003 (768 dims, legacy)
 *
 * Authentication: uses Application Default Credentials (ADC).
 */

import { GoogleAuth } from "google-auth-library";
import { logger } from "../../shared/logger";

const tag = "VertexEmbeddingsClient";

export const EMBEDDING_DIM = 768; // text-embedding-004 dimension

let _auth: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (_auth) return _auth;
  _auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return _auth;
}

function getProjectId(): string | null {
  return process.env.GCP_PROJECT_ID || null;
}

function getRegion(): string | null {
  return process.env.GCP_REGION || null;
}

function getModelName(): string {
  return process.env.VERTEX_EMBEDDING_MODEL || "text-embedding-004";
}

async function getAccessToken(): Promise<string | null> {
  try {
    const client = await getAuth().getClient();
    const tokenResponse = await client.getAccessToken();
    return tokenResponse.token || null;
  } catch (err) {
    logger.warn(tag, `Failed to get access token: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Generate embeddings for a batch of text strings.
 * Returns 768-dimensional vectors, or null for each input on failure.
 *
 * Batch size limit: 250 texts per request (Vertex AI limit).
 */
export async function embedBatch(
  texts: string[],
): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];

  const normalizedTexts = texts.map((text) => text.trim());
  const nonEmptyIndexes = normalizedTexts
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => text.length > 0);
  if (nonEmptyIndexes.length === 0) return texts.map(() => null);

  const project = getProjectId();
  const region = getRegion();

  if (!project || !region) {
    logger.warn(
      tag,
      "GCP_PROJECT_ID or GCP_REGION not configured — returning null embeddings",
    );
    return texts.map(() => null);
  }

  const BATCH_LIMIT = 250;
  if (nonEmptyIndexes.length > BATCH_LIMIT) {
    logger.warn(
      tag,
      `Batch size ${nonEmptyIndexes.length} exceeds limit ${BATCH_LIMIT} — splitting`,
    );
    const chunks: (number[] | null)[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_LIMIT) {
      const chunk = texts.slice(i, i + BATCH_LIMIT);
      const embeddings = await embedBatch(chunk);
      chunks.push(embeddings);
    }
    return chunks.flat();
  }

  const token = await getAccessToken();
  if (!token) {
    logger.warn(tag, "No access token — returning null embeddings");
    return texts.map(() => null);
  }

  const model = getModelName();
  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/google/models/${model}:predict`;

  try {
    // Vertex AI text embeddings API format
    const instances = nonEmptyIndexes.map(({ text }) => ({ content: text }));

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ instances }),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.warn(
        tag,
        `Embedding request failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
      );
      return texts.map(() => null);
    }

    const data = (await res.json()) as {
      predictions?: Array<{ embeddings?: { values?: number[] } }>;
    };

    if (
      !data.predictions ||
      data.predictions.length !== nonEmptyIndexes.length
    ) {
      logger.warn(
        tag,
        `Expected ${nonEmptyIndexes.length} predictions, got ${data.predictions?.length || 0}`,
      );
      return texts.map(() => null);
    }

    const output = texts.map((): number[] | null => null);
    data.predictions.forEach((pred, predictionIndex) => {
      const values = pred.embeddings?.values;
      if (!values || values.length !== EMBEDDING_DIM) {
        return;
      }
      output[nonEmptyIndexes[predictionIndex].index] = values;
    });
    return output;
  } catch (err) {
    logger.warn(tag, `Embedding batch failed: ${(err as Error).message}`);
    return texts.map(() => null);
  }
}

/**
 * Generate a single embedding (convenience wrapper).
 */
export async function embed(text: string): Promise<number[] | null> {
  const results = await embedBatch([text]);
  return results[0];
}

/**
 * Health check: verify the embedding API is reachable.
 */
export async function healthCheck(): Promise<boolean> {
  const result = await embed("test");
  return result !== null && result.length === EMBEDDING_DIM;
}

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns a score in [-1, 1], where 1 = identical, 0 = orthogonal, -1 = opposite.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}
