import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedEvent } from "../../../lib/types";
import { matchEvents } from "../../../lib/matching/matcher";
import {
  resetMatchingConfig,
  updateMatchingConfig,
} from "../../../lib/matching/config";
import { locateEventBySide } from "../../../lib/matching/locate";

vi.mock("../../../lib/matching/entities/resolver", () => ({
  resolveTeamSurface: vi.fn(async () => null),
  resolveCompetitionSurface: vi.fn(async () => null),
}));

vi.mock("../../../lib/matching/entities/match-harvester", () => ({
  harvestMatchPair: vi.fn(),
}));

function event(
  id: string,
  provider: keyof NormalizedEvent["providers"],
  homeTeam: string,
  awayTeam: string,
): NormalizedEvent {
  return {
    id,
    sport: "football",
    homeTeam,
    awayTeam,
    competition: "International Friendly",
    startTime: new Date("2026-06-05T00:00:00.000Z"),
    providers: {
      [provider]: {
        eventId: id.replace(`${provider}-`, ""),
        fetchedAt: new Date("2026-06-04T10:00:00.000Z"),
      },
    },
  };
}

describe("matchEvents", () => {
  afterEach(() => {
    resetMatchingConfig();
  });

  it("auto-merges same-orientation provider listings", async () => {
    updateMatchingConfig({ aliasHarvesting: { enabled: false } });

    const result = await matchEvents([
      event("pinnacle-1", "pinnacle", "Guatemala", "Czechia"),
      event("saba-sportsbook-1", "saba-sportsbook", "Guatemala", "Czechia"),
    ]);

    expect(result).toHaveLength(1);
    expect(Object.keys(result[0].providers).sort()).toEqual([
      "pinnacle",
      "saba-sportsbook",
    ]);
  });

  it("does not auto-merge swapped home/away provider listings", async () => {
    updateMatchingConfig({ aliasHarvesting: { enabled: false } });

    const result = await matchEvents([
      event("pinnacle-2", "pinnacle", "Guatemala", "Czechia"),
      event("saba-sportsbook-2", "saba-sportsbook", "Czechia", "Guatemala"),
    ]);

    expect(result).toHaveLength(2);
    expect(result.every((row) => Object.keys(row.providers).length === 1)).toBe(
      true,
    );
  });

  it("does not locate cached decision sides through swapped team slots", () => {
    const events = [
      event("saba-sportsbook-3", "saba-sportsbook", "Czechia", "Guatemala"),
    ];

    expect(
      locateEventBySide(
        {
          provider: "saba-sportsbook",
          homeTeam: "Guatemala",
          awayTeam: "Czechia",
          startTime: "2026-06-05T00:00:00.000Z",
        },
        events,
      ),
    ).toBeUndefined();

    expect(
      locateEventBySide(
        {
          provider: "saba-sportsbook",
          homeTeam: "Czechia",
          awayTeam: "Guatemala",
          startTime: "2026-06-05T00:00:00.000Z",
        },
        events,
      ),
    ).toBe(events[0]);
  });
});
