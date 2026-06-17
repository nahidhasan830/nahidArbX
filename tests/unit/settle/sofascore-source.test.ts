import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettleEvent } from "@/lib/settle/waterfall";

const fetchViaBrowser = vi.hoisted(() => vi.fn());

vi.mock("@/lib/settle/sources/sofascore-browser", () => ({
  fetchViaBrowser,
}));

vi.mock("@/lib/settle/aliases", () => ({
  applyTeamAlias: (raw: string) => raw,
  learnTeamAlias: vi.fn(),
}));

vi.mock("@/lib/shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

function resetSofaScoreDayCache(): void {
  const g = globalThis as typeof globalThis & Record<string, unknown>;
  delete g["__nahidArbX_settle:sofascore:day-events__"];
}

const event: SettleEvent = {
  eventId: "evt-inverse-only",
  homeTeam: "Lower Division Home",
  awayTeam: "Lower Division Away",
  competition: "Niche League",
  startTime: "2026-06-10T15:00:00.000Z",
};

describe("SofaScore source catalog", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    resetSofaScoreDayCache();
    fetchViaBrowser.mockImplementation(async (path: string) => {
      if (path === "/api/v1/sport/football/scheduled-events/2026-06-10") {
        return { events: [] };
      }
      if (
        path === "/api/v1/sport/football/scheduled-events/2026-06-10/inverse"
      ) {
        return {
          events: [
            {
              id: 12345,
              tournament: {
                name: "Niche League",
                category: { sport: { name: "Football", slug: "football" } },
              },
              homeTeam: { name: "Lower Division Home" },
              awayTeam: { name: "Lower Division Away" },
              homeScore: { current: 2, period1: 1, period2: 1 },
              awayScore: { current: 1, period1: 0, period2: 1 },
              status: { type: "finished", description: "Ended" },
              startTimestamp: Date.parse(event.startTime) / 1000,
            },
          ],
        };
      }
      return { events: [] };
    });
  });

  it("resolves matches that are present only in the inverse football catalog", async () => {
    const { fetchSofaScoreScores } =
      await import("@/lib/settle/sources/sofascore");

    const scores = await fetchSofaScoreScores([event]);

    expect(scores.get(event.eventId)).toMatchObject({
      source: "sofascore",
      ftHome: 2,
      ftAway: 1,
      htHome: 1,
      htAway: 0,
    });
    expect(fetchViaBrowser).toHaveBeenCalledWith(
      "/api/v1/sport/football/scheduled-events/2026-06-10/inverse",
    );
  });
});
