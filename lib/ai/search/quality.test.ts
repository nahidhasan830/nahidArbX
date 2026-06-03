import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isStrongVertexSearchResult } from "./quality";

describe("Vertex search quality gate", () => {
  it("accepts two content-bearing curated results", () => {
    assert.equal(isStrongVertexSearchResult(2, 224, 5), true);
  });

  it("keeps empty and thin results weak", () => {
    assert.equal(isStrongVertexSearchResult(0, 0, 5), false);
    assert.equal(isStrongVertexSearchResult(2, 120, 5), false);
  });

  it("allows one dense result for long-tail fixture pages", () => {
    assert.equal(isStrongVertexSearchResult(1, 240, 5), true);
  });
});
