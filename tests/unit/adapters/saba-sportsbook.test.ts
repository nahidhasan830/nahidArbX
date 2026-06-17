import { describe, expect, it, vi } from "vitest";
import type { SabaShowAllOddsData } from "@/lib/betting/saba/events-client";

const realSoccerEvents = vi.fn<
  () => Promise<{
    upcoming: SabaShowAllOddsData;
    today: SabaShowAllOddsData;
    live: SabaShowAllOddsData;
  }>
>();

vi.mock("@/lib/betting/saba/events-client", () => ({
  fetchRealSoccerEvents: realSoccerEvents,
  fetchSoccerShowAllOdds: vi.fn(),
}));

const { sabaSportsbookAdapter } =
  await import("@/lib/adapters/saba-sportsbook");

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
      "11": "Canada No.of Corners 15:01-30:00",
      "12": "Bosnia-Herzegovina No.of Corners 15:01-30:00",
      "13": "USA 00:00-15:00",
      "14": "Paraguay 00:00-15:00",
      "15": "Canada Total Bookings 30:01-45:00",
      "16": "Bosnia-Herzegovina Total Bookings 30:01-45:00",
      "17": "Canada",
      "18": "Bosnia-Herzegovina",
    },
    LeagueN: {
      "10": "FANTASY MATCH",
      "11": "International - Friendlies",
      "12": "SWEDEN ETTAN SOUTH",
      "13":
        "*WORLD CUP 2026 (IN CANADA, MEXICO & USA) - SPECIFIC 15 MINS NUMBER OF CORNERS",
      "14": "*WORLD CUP 2026 (IN CANADA, MEXICO & USA) - SPECIFIC 15 MINS",
      "15":
        "*WORLD CUP 2026 (IN CANADA, MEXICO & USA) - SPECIFIC 15 MINS TOTAL BOOKINGS",
      "16":
        "*WORLD CUP 2026 (IN CANADA, MEXICO & USA) - TOTAL CORNER & TOTAL GOAL",
      "17": "*WORLD CUP 2026 (IN CANADA, MEXICO & USA) - TOTAL GOALS MINUTES",
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
      {
        MatchId: 106,
        GameID: 1,
        LeagueId: 13,
        LeagueGroupId: 1,
        TeamId1: 11,
        TeamId2: 12,
        GameTime: sabaProviderTime(210),
      },
      {
        MatchId: 107,
        GameID: 1,
        LeagueId: 14,
        LeagueGroupId: 1,
        TeamId1: 13,
        TeamId2: 14,
        GameTime: sabaProviderTime(240),
      },
      {
        MatchId: 108,
        GameID: 1,
        LeagueId: 15,
        LeagueGroupId: 1,
        TeamId1: 15,
        TeamId2: 16,
        GameTime: sabaProviderTime(270),
      },
      {
        MatchId: 109,
        GameID: 1,
        LeagueId: 16,
        LeagueGroupId: 1,
        TeamId1: 17,
        TeamId2: 18,
        GameTime: sabaProviderTime(300),
      },
      {
        MatchId: 110,
        GameID: 1,
        LeagueId: 17,
        LeagueGroupId: 1,
        TeamId1: 17,
        TeamId2: 18,
        GameTime: sabaProviderTime(330),
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
          /\s-vs-\s/i.test(event.homeTeam) ||
          /specific|corner|booking|minutes/i.test(event.competition) ||
          /\d{2}:\d{2}-\d{2}:\d{2}|No\.of Corners|Total Bookings/i.test(
            `${event.homeTeam} ${event.awayTeam}`,
          ),
      ),
    ).toBe(false);
  });
});
