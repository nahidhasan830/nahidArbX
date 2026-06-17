import { describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const insertValues = vi.fn();
  const insert = vi.fn(() => ({
    values: insertValues,
  }));
  insertValues.mockReturnValue({
    onConflictDoUpdate: vi.fn(),
  });
  return { insert, insertValues };
});

vi.mock("../../../lib/db/client", () => ({
  db: {
    insert: dbMock.insert,
  },
}));

import {
  captureProviderSnapshots,
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

  it("does not persist Saba fantasy and synthetic market snapshots", async () => {
    const realEvent: NormalizedEvent = {
      id: "real",
      sport: "football",
      homeTeam: "Poland",
      awayTeam: "Nigeria",
      competition: "International - Friendlies",
      startTime: new Date("2026-06-03T18:45:00Z"),
      providers: {
        "saba-sportsbook": {
          eventId: "real",
          fetchedAt: new Date("2026-06-03T10:00:00Z"),
        },
      },
    };
    const fantasyEvent: NormalizedEvent = {
      id: "fantasy",
      sport: "football",
      homeTeam: "Albania + Italy",
      awayTeam: "Israel + Luxembourg",
      competition: "FANTASY MATCH",
      startTime: new Date("2026-06-03T18:00:00Z"),
      providers: {
        "saba-sportsbook": {
          eventId: "fantasy",
          fetchedAt: new Date("2026-06-03T10:00:00Z"),
        },
      },
    };
    const cornersWindowEvent: NormalizedEvent = {
      id: "corners-window",
      sport: "football",
      homeTeam: "Canada No.of Corners 15:01-30:00",
      awayTeam: "Bosnia-Herzegovina No.of Corners 15:01-30:00",
      competition:
        "*WORLD CUP 2026 (IN CANADA, MEXICO & USA) - SPECIFIC 15 MINS NUMBER OF CORNERS",
      startTime: new Date("2026-06-03T18:00:00Z"),
      providers: {
        "saba-sportsbook": {
          eventId: "corners-window",
          fetchedAt: new Date("2026-06-03T10:00:00Z"),
        },
      },
    };
    const minutesMarketEvent: NormalizedEvent = {
      id: "minutes-market",
      sport: "football",
      homeTeam: "USA 00:00-15:00",
      awayTeam: "Paraguay 00:00-15:00",
      competition:
        "*WORLD CUP 2026 (IN CANADA, MEXICO & USA) - SPECIFIC 15 MINS",
      startTime: new Date("2026-06-03T18:00:00Z"),
      providers: {
        "saba-sportsbook": {
          eventId: "minutes-market",
          fetchedAt: new Date("2026-06-03T10:00:00Z"),
        },
      },
    };

    await captureProviderSnapshots([
      {
        event: fantasyEvent,
        provider: "saba-sportsbook",
        providerEventId: "fantasy",
        fetchBatchId: "batch",
      },
      {
        event: cornersWindowEvent,
        provider: "saba-sportsbook",
        providerEventId: "corners-window",
        fetchBatchId: "batch",
      },
      {
        event: minutesMarketEvent,
        provider: "saba-sportsbook",
        providerEventId: "minutes-market",
        fetchBatchId: "batch",
      },
      {
        event: realEvent,
        provider: "saba-sportsbook",
        providerEventId: "real",
        fetchBatchId: "batch",
      },
    ]);

    const rows = dbMock.insertValues.mock.calls[0][0] as Array<{
      providerEventId: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].providerEventId).toBe("real");
  });
});
