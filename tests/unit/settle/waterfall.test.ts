import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MatchScore } from "@/lib/settle/types";
import type { SettleEvent } from "@/lib/settle/waterfall";

vi.mock("@/lib/db/repositories/match-scores", () => ({
  getScoresByEventIds: vi.fn(),
  saveScoreIfAbsent: vi.fn().mockResolvedValue("inserted"),
  upsertScoreForce: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/settle/sources/espn", () => ({
  fetchEspnScores: vi.fn(),
  enrichEspnStats: vi.fn().mockResolvedValue({ enriched: 0, skipped: 0 }),
}));

vi.mock("@/lib/settle/sources/sofascore", () => ({
  fetchSofaScoreScores: vi.fn(),
}));

vi.mock("@/lib/settle/sources/api-football", () => ({
  fetchApiFootballScores: vi.fn(),
  enrichApiFootballStats: vi.fn().mockResolvedValue({ enriched: 0, skipped: 0 }),
  getApiFootballQuota: vi
    .fn()
    .mockReturnValue({ dailyLimit: 100, used: 0, remaining: 100 }),
}));

vi.mock("@/lib/settle/sources/sofascore-browser", () => ({
  getBrowserSessionStats: vi.fn().mockReturnValue({
    alive: true,
    consecutiveFailures: 0,
  }),
}));

vi.mock("@/lib/shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { getScoresByEventIds } from "@/lib/db/repositories/match-scores";
import { fetchEspnScores } from "@/lib/settle/sources/espn";
import { fetchSofaScoreScores } from "@/lib/settle/sources/sofascore";
import {
  fetchApiFootballScores,
  getApiFootballQuota,
} from "@/lib/settle/sources/api-football";
import { resolveScores } from "@/lib/settle/waterfall";

const event: SettleEvent = {
  eventId: "evt1",
  homeTeam: "Home",
  awayTeam: "Away",
  competition: "League",
  startTime: "2026-01-01T15:00:00Z",
};

const score = (
  source: MatchScore["source"],
  overrides: Partial<MatchScore> = {},
): MatchScore => ({
  eventId: "evt1",
  status: "FT",
  htHome: 1,
  htAway: 0,
  ftHome: 2,
  ftAway: 1,
  source,
  confidence: 0.95,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getScoresByEventIds).mockResolvedValue(new Map());
  vi.mocked(fetchEspnScores).mockResolvedValue(new Map());
  vi.mocked(fetchSofaScoreScores).mockResolvedValue(new Map());
  vi.mocked(fetchApiFootballScores).mockResolvedValue(new Map());
  vi.mocked(getApiFootballQuota).mockReturnValue({
    dailyLimit: 100,
    used: 0,
    remaining: 100,
  });
});

describe("resolveScores source order", () => {
  it("uses SofaScore in the same tick after ESPN misses and does not call API-Football", async () => {
    vi.mocked(fetchSofaScoreScores).mockResolvedValue(
      new Map([["evt1", score("sofascore")]]),
    );

    const result = await resolveScores([event]);

    expect(result.scores.get("evt1")?.source).toBe("sofascore");
    expect(fetchApiFootballScores).not.toHaveBeenCalled();
    expect(result.telemetry.eventsResolvedBySofaScore).toBe(1);
    expect(result.telemetry.eventsStillUnresolved).toBe(0);
  });

  it("calls API-Football in the same tick only after ESPN and SofaScore miss", async () => {
    vi.mocked(fetchApiFootballScores).mockResolvedValue(
      new Map([["evt1", score("api-football")]]),
    );

    const result = await resolveScores([event]);

    expect(fetchEspnScores).toHaveBeenCalledWith([event]);
    expect(fetchSofaScoreScores).toHaveBeenCalledWith([event], {
      withCorners: false,
      withBookings: false,
    });
    expect(fetchApiFootballScores).toHaveBeenCalledWith([event]);
    expect(result.scores.get("evt1")?.source).toBe("api-football");
    expect(result.telemetry.eventsResolvedByApiFootball).toBe(1);
  });

  it("continues past ESPN when the event needs HT data ESPN did not provide", async () => {
    vi.mocked(fetchEspnScores).mockResolvedValue(
      new Map([["evt1", score("espn", { htHome: null, htAway: null })]]),
    );
    vi.mocked(fetchSofaScoreScores).mockResolvedValue(
      new Map([["evt1", score("sofascore", { htHome: 1, htAway: 0 })]]),
    );

    const result = await resolveScores([event], { needsHtScore: true });

    expect(fetchApiFootballScores).not.toHaveBeenCalled();
    expect(result.scores.get("evt1")?.source).toBe("sofascore");
    expect(result.scores.get("evt1")?.htHome).toBe(1);
    expect(result.telemetry.eventsResolvedByEspn).toBe(0);
    expect(result.telemetry.eventsResolvedBySofaScore).toBe(1);
  });

  it("settles from cache even when network retry is blocked", async () => {
    vi.mocked(getScoresByEventIds).mockResolvedValue(
      new Map([["evt1", score("espn")]]),
    );

    const result = await resolveScores([event], { networkEventIds: new Set() });

    expect(fetchEspnScores).not.toHaveBeenCalled();
    expect(fetchSofaScoreScores).not.toHaveBeenCalled();
    expect(fetchApiFootballScores).not.toHaveBeenCalled();
    expect(result.scores.get("evt1")?.source).toBe("espn");
    expect(result.telemetry.eventsResolvedFromCache).toBe(1);
    expect(result.telemetry.eventsSkippedByBackoff).toBe(0);
  });
});
