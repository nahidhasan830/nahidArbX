import assert from "node:assert/strict";
import { describe, it } from "node:test";

async function loadGate() {
  process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
  const mod = await import("./query-refiner");
  return mod.shouldUseDeepSeekVertexRefiner;
}

describe("Vertex search DeepSeek refiner gate", () => {
  it("keeps short clean fixtures on deterministic Vertex rewrites only", async () => {
    const shouldUseDeepSeekVertexRefiner = await loadGate();
    assert.equal(
      shouldUseDeepSeekVertexRefiner(
        "Poland Nigeria 2026-06-03 football fixture",
      ),
      false,
    );
  });

  it("allows DeepSeek as a fallback for long exhausted fixture queries", async () => {
    const shouldUseDeepSeekVertexRefiner = await loadGate();
    const originalKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "test-key";
    try {
      assert.equal(
        shouldUseDeepSeekVertexRefiner(
          "alpha beta gamma delta 2026-06-01 Example League football fixture",
        ),
        true,
      );
    } finally {
      if (originalKey === undefined) {
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = originalKey;
      }
    }
  });
});
