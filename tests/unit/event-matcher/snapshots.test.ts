import { describe, expect, it } from "vitest";
import {
  snapshotIdFor,
  toSnapshotInput,
} from "../../../lib/event-matcher/snapshots";
import type { NormalizedEvent } from "../../../lib/types";

describe("event matcher snapshots", () => {
  it("normalizes raw provider event fields before persistence", () => {
    const event: NormalizedEvent = {
      id: "evt",
      sport: "football",
      homeTeam: "FC Barcelona",
      awayTeam: "Real Madrid",
      competition: "Spanish La Liga",
      startTime: new Date("2026-01-01T10:00:00Z"),
      providers: {
        pinnacle: {
          eventId: "p1",
          fetchedAt: new Date("2026-01-01T09:00:00Z"),
        },
      },
    };
    const snapshot = toSnapshotInput({
      event,
      provider: "pinnacle",
      providerEventId: "p1",
      fetchBatchId: "batch",
    });
    expect(snapshot.homeTeamNormalized).toBe("barcelona");
    expect(snapshot.awayTeamNormalized).toBe("real madrid");
    expect(snapshot.providerEventId).toBe("p1");
  });

  it("uses a stable snapshot id across fetch batches", () => {
    const first = snapshotIdFor({
      provider: "pinnacle",
      providerEventId: "p1",
      fetchBatchId: "batch-a",
    });
    const second = snapshotIdFor({
      provider: "pinnacle",
      providerEventId: "p1",
      fetchBatchId: "batch-b",
    });
    expect(second).toBe(first);
  });
});
