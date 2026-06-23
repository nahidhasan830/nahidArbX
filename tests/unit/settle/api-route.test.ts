import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const betsRepository = {
  getBetsByIds: vi.fn(),
  getPendingBetsByEventIds: vi.fn(),
};

const settleBatchMock = vi.fn();

vi.mock("@/lib/db/repositories/bets", () => betsRepository);
vi.mock("@/lib/settle/settle-batch", () => ({
  settleBatch: settleBatchMock,
}));
vi.mock("@/lib/shared/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const route = await import("../../../app/api/bets-history/settle/route");

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/bets-history/settle", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt1|match|home",
    eventId: "evt1",
    familyId: "match",
    atomId: "home",
    atomLabel: "Home",
    homeTeam: "A",
    awayTeam: "B",
    competition: "League",
    eventStartTime: "2026-01-01T15:00:00.000Z",
    marketType: "MATCH_RESULT",
    timeScope: "FT",
    familyLine: null,
    outcome: "pending",
    ...overrides,
  };
}

const telemetry = {
  total: 1,
  tier0_hits: 0,
  tier1_hits: 0,
  tier2_hits: 1,
  tier3_hits: 0,
  tier4_hits: 0,
  unresolved: 0,
  durationMs: 12,
  eventsTotal: 1,
  eventsAttempted: 1,
  eventsSkippedByBackoff: 0,
  eventsResolvedFromCache: 0,
  eventsResolvedByEspn: 1,
  eventsResolvedBySofaScore: 0,
  eventsResolvedByApiFootball: 0,
  eventsStillUnresolved: 0,
  apiFootballRequestsUsed: 0,
  sourceIssues: [],
  settledDeterministically: 2,
  unsupported: 0,
  unresolvedEvents: 0,
};

describe("POST /api/bets-history/settle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("expands one selected market to pending sibling markets for the same event", async () => {
    const selected = makeRow();
    const sibling = makeRow({
      id: "evt1|total|over_2_5",
      familyId: "total",
      atomId: "over_2_5",
      atomLabel: "Over 2.5",
      marketType: "OVER_UNDER",
      familyLine: 2.5,
    });

    betsRepository.getBetsByIds.mockResolvedValueOnce([selected]);
    betsRepository.getPendingBetsByEventIds.mockResolvedValueOnce([
      selected,
      sibling,
    ]);
    settleBatchMock.mockResolvedValueOnce({
      proposals: [
        {
          id: selected.id,
          proposedOutcome: "won",
          confidence: 1,
          reasoning: "Home won 2-1.",
          score: "2-1",
          tier: "pure",
          source: "espn",
        },
        {
          id: sibling.id,
          proposedOutcome: "won",
          confidence: 1,
          reasoning: "Total goals 3 > 2.5.",
          score: "2-1",
          tier: "pure",
          source: "espn",
        },
      ],
      missing: [],
      telemetry,
      eventBreakdown: {
        networkAttemptedEventIds: ["evt1"],
        skippedByBackoffEventIds: [],
        fullyResolvedEventIds: ["evt1"],
        stillUnresolvedEventIds: [],
      },
    });

    const response = await route.POST(request({ ids: [selected.id] }));
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(betsRepository.getPendingBetsByEventIds).toHaveBeenCalledWith([
      "evt1",
    ]);
    expect(settleBatchMock).toHaveBeenCalledWith(
      [selected.id, sibling.id],
      { bypassCache: true },
    );
    expect(body).toMatchObject({
      ok: true,
      data: {
        attempted: 2,
        missing: [],
        expandedIds: [selected.id, sibling.id],
        unresolvedEventCount: 0,
      },
    });
    expect((body.data as { includedRows: unknown[] }).includedRows).toEqual([
      selected,
      sibling,
    ]);
  });
});
