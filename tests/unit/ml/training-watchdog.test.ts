import { describe, expect, it } from "vitest";
import {
  getTrainingHeartbeatAgeMs,
  isTrainingRunStale,
  staleTrainingReason,
} from "@/lib/optimizer/training-watchdog";

const NOW = Date.parse("2026-05-24T04:53:27.668Z");
const TIMEOUT = 45 * 60 * 1000;

describe("ML training watchdog", () => {
  it("uses last heartbeat as the freshness anchor", () => {
    const row = {
      id: "cloud-training-active",
      trainingStartedAt: "2026-05-24T03:00:00.000Z",
      lastHeartbeatAt: "2026-05-24T04:30:00.000Z",
    };

    expect(getTrainingHeartbeatAgeMs(row, NOW)).toBe(
      NOW - Date.parse(row.lastHeartbeatAt),
    );
    expect(isTrainingRunStale(row, NOW, TIMEOUT)).toBe(false);
  });

  it("falls back to trainingStartedAt when no heartbeat has landed", () => {
    const row = {
      id: "cloud-training-never-heartbeat",
      trainingStartedAt: "2026-05-24T03:30:00.000Z",
      lastHeartbeatAt: null,
    };

    expect(getTrainingHeartbeatAgeMs(row, NOW)).toBe(
      NOW - Date.parse(row.trainingStartedAt),
    );
    expect(isTrainingRunStale(row, NOW, TIMEOUT)).toBe(true);
  });

  it("builds an operator-readable terminal failure reason", () => {
    const row = {
      id: "cloud-training-stale",
      trainingStartedAt: "2026-05-24T03:00:00.000Z",
      lastHeartbeatAt: "2026-05-24T03:30:00.000Z",
    };
    const ageMs = NOW - Date.parse(row.lastHeartbeatAt);

    expect(staleTrainingReason(row, ageMs, TIMEOUT)).toContain(
      "Training watchdog marked this run failed",
    );
    expect(staleTrainingReason(row, ageMs, TIMEOUT)).toContain(
      "no heartbeat since 2026-05-24T03:30:00.000Z",
    );
  });
});
