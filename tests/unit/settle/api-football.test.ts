import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettleEvent } from "@/lib/settle/waterfall";

const axiosGet = vi.hoisted(() => vi.fn());

vi.mock("axios", () => ({
  default: {
    get: axiosGet,
  },
}));

vi.mock("@/lib/shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const event: SettleEvent = {
  eventId: "evt-old",
  homeTeam: "Home",
  awayTeam: "Away",
  competition: "League",
  startTime: "2026-06-04T15:00:00.000Z",
};

const currentWindowEvent: SettleEvent = {
  eventId: "evt-current",
  homeTeam: "Home",
  awayTeam: "Away",
  competition: "League",
  startTime: "2026-06-10T12:00:00.000Z",
};

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("API_FOOTBALL_KEY", "test-key");
  axiosGet.mockReset();
});

describe("API-Football source issues", () => {
  it("records plan denials and skips later dates outside the returned access window", async () => {
    axiosGet.mockResolvedValue({
      data: {
        results: 0,
        errors: {
          plan: "Free plans do not have access to this date, try from 2026-06-09 to 2026-06-11.",
        },
        response: [],
      },
    });

    const {
      clearApiFootballSourceIssues,
      drainApiFootballSourceIssues,
      fetchApiFootballScores,
    } = await import("@/lib/settle/sources/api-football");

    clearApiFootballSourceIssues();
    const scores = await fetchApiFootballScores([event]);

    expect(scores.size).toBe(0);
    expect(axiosGet).toHaveBeenCalledTimes(1);
    expect(axiosGet.mock.calls[0]?.[1]?.params).toEqual({
      date: "2026-06-03",
    });
    expect(drainApiFootballSourceIssues()).toEqual([
      "API-Football access issue on /fixtures: plan: Free plans do not have access to this date, try from 2026-06-09 to 2026-06-11.",
    ]);
  });

  it("reuses clean fixture date responses within the same settlement process", async () => {
    axiosGet.mockResolvedValue({
      data: {
        results: 0,
        errors: [],
        response: [],
      },
    });

    const { fetchApiFootballScores } =
      await import("@/lib/settle/sources/api-football");

    await fetchApiFootballScores([currentWindowEvent]);
    await fetchApiFootballScores([currentWindowEvent]);

    expect(axiosGet).toHaveBeenCalledTimes(3);
    expect(axiosGet.mock.calls.map((call) => call[1]?.params?.date)).toEqual([
      "2026-06-09",
      "2026-06-10",
      "2026-06-11",
    ]);
  });
});
