import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMBEDDING_DIM,
  embedBatch,
} from "../../../lib/matching/entities/vertex-embeddings-client";

const authMocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock("google-auth-library", () => ({
  GoogleAuth: vi.fn(function GoogleAuth() {
    return {
      getClient: authMocks.getClient,
    };
  }),
}));

function vector(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIM }, (_, index) => seed + index);
}

describe("Vertex embeddings client", () => {
  beforeEach(() => {
    vi.stubEnv("GCP_PROJECT_ID", "test-project");
    vi.stubEnv("GCP_REGION", "us-central1");
    authMocks.getAccessToken.mockResolvedValue({ token: "token" });
    authMocks.getClient.mockResolvedValue({
      getAccessToken: authMocks.getAccessToken,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns null embeddings for blank text without calling Vertex", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await embedBatch(["", "   "]);

    expect(result).toEqual([null, null]);
    expect(authMocks.getClient).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("trims text sent to Vertex and preserves blank positions", async () => {
    const alpha = vector(1);
    const beta = vector(2);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toEqual({
        instances: [{ content: "Alpha" }, { content: "Beta" }],
      });
      return new Response(
        JSON.stringify({
          predictions: [
            { embeddings: { values: alpha } },
            { embeddings: { values: beta } },
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await embedBatch([" Alpha ", "", "Beta", "  "]);

    expect(result).toEqual([alpha, null, beta, null]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
