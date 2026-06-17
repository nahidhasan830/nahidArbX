import test from "node:test";
import assert from "node:assert/strict";

import {
  getLogRetentionCutoff,
  getLogRetentionStatus,
} from "./log-retention";

test("log retention cutoff keeps the last seven days", () => {
  const cutoff = getLogRetentionCutoff(
    new Date("2026-06-13T00:00:00.000Z"),
  );

  assert.equal(cutoff.toISOString(), "2026-06-06T00:00:00.000Z");
});

test("log retention scheduler starts inactive", () => {
  assert.deepEqual(getLogRetentionStatus(), {
    active: false,
    running: false,
    lastRun: null,
    lastError: null,
  });
});
