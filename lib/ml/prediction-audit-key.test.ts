import test from "node:test";
import assert from "node:assert/strict";
import { buildPredictionKey } from "./prediction-audit-key";

const base = {
  betId: "event-1|FT_MATCH_RESULT|HOME",
  modelVersion: 7,
  softProvider: "ninewickets-exchange",
  softOdds: 2.123456,
  sharpOdds: 2.01234,
  mlScore: 0.5678912,
  modelEdgePct: 4.32191,
  mlFeatureVersion: 3,
  mlFeatureNamesHash: "feature-hash",
};

test("buildPredictionKey is stable for insignificant float noise", () => {
  const a = buildPredictionKey(base);
  const b = buildPredictionKey({
    ...base,
    softOdds: 2.123459,
    sharpOdds: 2.012339,
    mlScore: 0.56789123,
    modelEdgePct: 4.321914,
  });

  assert.equal(a, b);
});

test("buildPredictionKey fingerprints model and score context", () => {
  const original = buildPredictionKey(base);
  const nextModel = buildPredictionKey({ ...base, modelVersion: 8 });
  const nextScore = buildPredictionKey({ ...base, mlScore: 0.6678912 });

  assert.notEqual(original, nextModel);
  assert.notEqual(original, nextScore);
});
