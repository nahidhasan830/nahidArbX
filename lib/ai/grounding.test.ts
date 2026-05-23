import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";

async function getHooks() {
  const mod = await import("./grounding");
  return mod.__groundingTestHooks;
}

describe("grounding entity-match parsing", () => {
  it("recovers a decisive verdict from truncated DeepSeek JSON", async () => {
    const hooks = await getHooks();
    const verdict = hooks.parseMatchVerdict(
      `{
  "decision": "DIFFERENT",
  "confidence": 95,
  "reasoning": "The first fixture involves Dukla Prague and Banik Ostrava in the Czech 1 Liga, while the second involves Banik Ostrava B and Sparta Prague B in the Czech 2 Liga; web evidence confirms separate matches`,
      { finishReason: "length" },
    );

    assert.equal(verdict.decision, "DIFFERENT");
    assert.equal(verdict.confidence, 95);
    assert.match(verdict.reasoning, /\[truncated\]/);
    assert.deepEqual(verdict.diagnostics, {
      parseStatus: "recovered",
      finishReason: "length",
      warning: "Recovered fields from a truncated AI JSON response.",
    });
  });

  it("surfaces unrecoverable truncation as an explicit uncertain parse failure", async () => {
    const hooks = await getHooks();
    const verdict = hooks.parseMatchVerdict("", {
      finishReason: "length",
      eventA: {
        homeTeam: "Arsenal",
        awayTeam: "Chelsea",
        competition: "Premier League",
        startTime: "2026-05-23T12:00:00Z",
      },
      eventB: {
        homeTeam: "Arsenal",
        awayTeam: "Chelsea",
        competition: "Premier League",
        startTime: "2026-05-23T12:00:00Z",
      },
    });

    assert.equal(verdict.decision, "UNCERTAIN");
    assert.equal(verdict.confidence, 50);
    assert.match(verdict.reasoning, /truncated/);
    assert.deepEqual(verdict.diagnostics, {
      parseStatus: "invalid",
      finishReason: "length",
      warning: "AI response was truncated before valid JSON could be parsed.",
    });
  });

  it("parses wrapped batch verdicts and normalizes prompt pair numbers to zero-based indexes", async () => {
    const hooks = await getHooks();
    const result = hooks.parseBatchVerdict(
      JSON.stringify({
        verdicts: [
          {
            pair: 1,
            decision: "SAME",
            confidence: 91,
            reasoning: "same fixture",
          },
          {
            pair: 2,
            decision: "DIFFERENT",
            confidence: 94,
            reasoning: "different teams",
          },
        ],
      }),
      2,
    );

    assert.equal(result.verdicts[0].pairIndex, 0);
    assert.equal(result.verdicts[0].decision, "SAME");
    assert.equal(result.verdicts[1].pairIndex, 1);
    assert.equal(result.verdicts[1].decision, "DIFFERENT");
  });

  it("recovers partial batch verdicts", async () => {
    const hooks = await getHooks();
    const result = hooks.parseBatchVerdict(
      `{"verdicts":[{"pair":1,"decision":"DIFFERENT","confidence":95,"reasoning":"B team differs"`,
      1,
      { finishReason: "length" },
    );

    assert.equal(result.verdicts[0].pairIndex, 0);
    assert.equal(result.verdicts[0].decision, "DIFFERENT");
    assert.equal(result.verdicts[0].confidence, 95);
    assert.deepEqual(result.verdicts[0].diagnostics, {
      parseStatus: "recovered",
      finishReason: "length",
      warning: "Recovered fields from a truncated AI JSON response.",
    });
  });
});
