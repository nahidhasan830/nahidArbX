import { describe, expect, it, vi } from "vitest";
import type { SabaShowAllOddsData } from "@/lib/betting/saba/events-client";

const realSoccerEvents = vi.fn<() => Promise<{
  upcoming: SabaShowAllOddsData;
  today: SabaShowAllOddsData;
  live: SabaShowAllOddsData;
}>>();

vi.mock("@/lib/betting/saba/events-client", () => ({
  fetchRealSoccerEvents: realSoccerEvents,
  fetchSoccerShowAllOdds: vi.fn(),
}));

const { sabaSportsbookAdapter } = await import("@/lib/adapters/saba-sportsbook");

function sabaProviderTime(offsetMinutes: number): string {
  const kickoff = new Date(Date.now() + offsetMinutes * 60_000);
  const providerTime = new Date(kickoff.getTime() - 4 * 60 * 60 * 1000);
  return providerTime.toISOString().replace(/\.\d{3}Z$/, "");
}

function sabaData(): SabaShowAllOddsData {
  return {
    TeamN: {
      "1": "Albania + Italy",
      "2": "Israel + Luxembourg",
      "3": "Netherlands + Italy",
      "4": "Algeria + Luxembourg",
      "5": "Team Alpha-vs-Team Beta",
      "6": "Team Gamma",
      "7": "Poland",
      "8": "Nigeria",
      "9": "BK Olympic",
      "10": "Lunds BK",
    },
    LeagueN: {
      "10": "FANTASY MATCH",
      "11": "International - Friendlies",
      "12": "SWEDEN ETTAN SOUTH",
    },
    NewMatch: [
      {
        MatchId: 101,
        GameID: 1,
        LeagueId: 10,
        LeagueGroupId: 1,
        TeamId1: 1,
        TeamId2: 2,
        GameTime: sabaProviderTime(60),
      },
      {
        MatchId: 102,
        GameID: 1,
        LeagueId: 11,
        LeagueGroupId: 1,
        TeamId1: 3,
        TeamId2: 4,
        GameTime: sabaProviderTime(90),
      },
      {
        MatchId: 103,
        GameID: 1,
        LeagueId: 11,
        LeagueGroupId: 1,
        TeamId1: 5,
        TeamId2: 6,
        GameTime: sabaProviderTime(120),
      },
      {
        MatchId: 104,
        GameID: 1,
        LeagueId: 11,
        LeagueGroupId: 1,
        TeamId1: 7,
        TeamId2: 8,
        GameTime: sabaProviderTime(150),
      },
      {
        MatchId: 105,
        GameID: 1,
        LeagueId: 12,
        LeagueGroupId: 1,
        TeamId1: 9,
        TeamId2: 10,
        GameTime: sabaProviderTime(180),
      },
    ],
  };
}

describe("sabaSportsbookAdapter", () => {
  it("filters Saba fantasy and synthetic market rows at the event source", async () => {
    realSoccerEvents.mockResolvedValue({
      upcoming: sabaData(),
      today: {},
      live: {},
    });

    const events = await sabaSportsbookAdapter.fetchEvents();

    expect(events.map((event) => event.homeTeam)).toEqual([
      "Poland",
      "BK Olympic",
    ]);
    expect(events).toHaveLength(2);
    expect(
      events.some(
        (event) =>
          event.competition === "FANTASY MATCH" ||
          event.homeTeam.includes("+") ||
          event.awayTeam.includes("+") ||
          /\s-vs-\s/i.test(event.homeTeam),
      ),
    ).toBe(false);
  });
});
