/**
 * Vertex AI Prediction Client — LightGBM Model Inference
 *
 * Calls a deployed Vertex AI Prediction endpoint for batch bet scoring.
 * Replaces the local ONNX scorer with cloud-managed inference.
 *
 * Configuration (via .env):
 *   VERTEX_PREDICTION_ENDPOINT — optional endpoint id, full resource name, or URL
 *   ml_models.vertex_endpoint_name — fallback written by the trainer
 *   GCP_PROJECT_ID — GCP project ID (already configured)
 *   GCP_REGION — GCP region (already configured)
 *
 * Endpoint format:
 *   projects/{project}/locations/{region}/endpoints/{endpoint-id}
 *
 * Authentication: uses Application Default Credentials (ADC) via google-auth-library.
 * The engine process must have Vertex AI User role on the endpoint.
 */

import { GoogleAuth } from "google-auth-library";
import { FEATURE_COUNT } from "./feature-contract";
import { logger } from "../shared/logger";

const tag = "VertexPredictionClient";

const TIMEOUT_MS = 5000; // 5s timeout for batch inference
const MAX_BATCH_SIZE = 100; // Vertex AI batch limit

interface PredictionRequest {
  instances: number[][];
}

interface PredictionResponse {
  predictions: number[][];
  deployedModelId?: string;
  model?: string;
  modelDisplayName?: string;
  modelVersionId?: string;
}

let _auth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (_auth) return _auth;
  _auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  return _auth;
}

let endpointOverride: string | null = null;

function cleanEndpoint(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Runtime fallback populated from ml_models.vertex_endpoint_name.
 * VERTEX_PREDICTION_ENDPOINT still wins when it is explicitly configured.
 */
export function setVertexPredictionEndpoint(endpoint: string | null): void {
  endpointOverride = cleanEndpoint(endpoint);
}

export function getVertexPredictionEndpoint(): string | null {
  return (
    cleanEndpoint(process.env.VERTEX_PREDICTION_ENDPOINT) ?? endpointOverride
  );
}

function toEndpointResourceName(endpoint: string): string | null {
  const fullResource = endpoint.match(
    /^projects\/([^/]+)\/locations\/([^/]+)\/endpoints\/([^/]+)$/,
  );
  if (fullResource) return endpoint;

  const endpointId = endpoint.startsWith("endpoints/")
    ? endpoint.slice("endpoints/".length)
    : endpoint;
  if (endpointId.includes("/")) return null;

  const project = cleanEndpoint(process.env.GCP_PROJECT_ID);
  const region = cleanEndpoint(process.env.GCP_REGION);
  if (!project || !region) return null;

  return `projects/${project}/locations/${region}/endpoints/${endpointId}`;
}

function getEndpointUrl(): string | null {
  const endpoint = getVertexPredictionEndpoint();
  if (!endpoint) return null;

  // If it's already a full URL, use it
  if (endpoint.startsWith("http")) return endpoint;

  // If it's a resource name, convert to REST API URL
  // projects/{project}/locations/{region}/endpoints/{endpoint-id}
  // → https://{region}-aiplatform.googleapis.com/v1/{resource}:predict
  const resourceName = toEndpointResourceName(endpoint);
  const match = resourceName?.match(
    /^projects\/([^/]+)\/locations\/([^/]+)\/endpoints\/([^/]+)$/,
  );
  if (!match) {
    logger.warn(
      tag,
      `Invalid Vertex prediction endpoint format: ${endpoint}. Expected URL, projects/{project}/locations/{region}/endpoints/{id}, or endpoint id with GCP_PROJECT_ID/GCP_REGION`,
    );
    return null;
  }

  const [, , region] = match;
  return `https://${region}-aiplatform.googleapis.com/v1/${resourceName}:predict`;
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
 * Call Vertex AI Prediction endpoint with a batch of feature vectors.
 * Returns probability scores [0, 1] for each input, or null on failure.
 */
export async function predictBatch(
  featureArrays: number[][],
): Promise<(number | null)[]> {
  if (featureArrays.length === 0) return [];

  const url = getEndpointUrl();
  if (!url) {
    logger.warn(
      tag,
      "Vertex prediction endpoint not configured — returning null scores",
    );
    return featureArrays.map(() => null);
  }

  if (featureArrays.length > MAX_BATCH_SIZE) {
    logger.warn(
      tag,
      `Batch size ${featureArrays.length} exceeds limit ${MAX_BATCH_SIZE} — splitting`,
    );
    const chunks: (number | null)[][] = [];
    for (let i = 0; i < featureArrays.length; i += MAX_BATCH_SIZE) {
      const chunk = featureArrays.slice(i, i + MAX_BATCH_SIZE);
      const scores = await predictBatch(chunk);
      chunks.push(scores);
    }
    return chunks.flat();
  }

  const token = await getAccessToken();
  if (!token) {
    logger.warn(tag, "No access token — returning null scores");
    return featureArrays.map(() => null);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const body: PredictionRequest = { instances: featureArrays };
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text();
      logger.warn(
        tag,
        `Prediction failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
      );
      return featureArrays.map(() => null);
    }

    const data = (await res.json()) as PredictionResponse;

    // Vertex AI returns predictions as [[prob_class_0, prob_class_1], ...]
    // We want prob_class_1 (probability of win)
    if (!data.predictions || !Array.isArray(data.predictions)) {
      logger.warn(tag, "Invalid prediction response format");
      return featureArrays.map(() => null);
    }

    return data.predictions.map((pred) => {
      if (!Array.isArray(pred) || pred.length < 2) return null;
      const probWin = pred[1]; // class 1 = win
      if (typeof probWin !== "number" || probWin < 0 || probWin > 1) {
        return null;
      }
      return probWin;
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === "AbortError") {
      logger.warn(tag, `Prediction timeout after ${TIMEOUT_MS}ms`);
    } else {
      logger.warn(tag, `Prediction error: ${(err as Error).message}`);
    }
    return featureArrays.map(() => null);
  }
}

/**
 * Health check: verify the endpoint is reachable and returns valid predictions.
 */
export async function healthCheck(): Promise<boolean> {
  const url = getEndpointUrl();
  if (!url) return false;

  // Send a dummy feature vector (current contract length, all zeros)
  const dummy = Array(FEATURE_COUNT).fill(0);
  const scores = await predictBatch([dummy]);

  return scores.length === 1 && scores[0] !== null;
}
