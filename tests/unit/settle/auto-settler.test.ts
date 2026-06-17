import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/repositories/bets", () => ({
  listBets: vi.fn(),
  recordSettleAttempts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/settle/settle-batch", () => ({
  settleBatch: vi.fn(),
}));

vi.mock("@/lib/settle/apply-outcomes", () => ({
  applySettlementOutcomes: vi.fn(),
}));

vi.mock("@/lib/db/repositories/settlement-runs", () => ({
  estimateRunCost: vi.fn().mockReturnValue(0),
  recordSettlementRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/settle/sources/api-football", () => ({
  getApiFootballQuota: vi
    .fn()
    .mockReturnValue({ dailyLimit: 100, used: 0, remaining: 100 }),
}));

vi.mock("@/lib/notifier", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runAutoSettle } from "@/lib/settle/auto-settler";
import { listBets } from "@/lib/db/repositories/bets";
import { settleBatch } from "@/lib/settle/settle-batch";
import { applySettlementOutcomes } from "@/lib/settle/apply-outcomes";
import { recordSettleAttempts } from "@/lib/db/repositories/bets";
import { notify } from "@/lib/notifier";
import { getApiFootballQuota } from "@/lib/settle/sources/api-football";

const mockTelemetry = {
  total: 1,
  tier0_hits: 1,
  tier1_hits: 0,
  tier2_hits: 0,
  tier3_hits: 0,
  tier4_hits: 0,
  unresolved: 0,
  durationMs: 10,
  eventsTotal: 1,
  eventsAttempted: 0,
  eventsSkippedByBackoff: 0,
  eventsResolvedFromCache: 1,
  eventsResolvedByEspn: 0,
  eventsResolvedBySofaScore: 0,
  eventsResolvedByApiFootball: 0,
  eventsStillUnresolved: 0,
  apiFootballRequestsUsed: 0,
  sourceIssues: [],
  settledDeterministically: 1,
  unsupported: 0,
  unresolvedEvents: 0,
};

const eventBreakdown = (overrides: Record<string, string[]> = {}) => ({
  networkAttemptedEventIds: [],
  skippedByBackoffEventIds: [],
  fullyResolvedEventIds: ["evt1"],
  stillUnresolvedEventIds: [],
  ...overrides,
});

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt1|fam1|atom1",
    eventId: "evt1",
    familyId: "fam1",
    atomId: "ft_home_win",
    atomLabel: "Home Win",
    homeTeam: "Arsenal",
    awayTeam: "Chelsea",
    competition: "EPL",
    eventStartTime: "2026-01-01T15:00:00Z",
    marketType: "MATCH_RESULT",
    timeScope: "FT",
    familyLine: null,
    placedAt: null,
    outcome: "pending",
    settleAttempts: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(applySettlementOutcomes).mockResolvedValue(0);
  vi.mocked(getApiFootballQuota).mockReturnValue({
    dailyLimit: 100,
    used: 0,
    remaining: 100,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runAutoSettle", () => {
  it("returns immediately when no bets are ready", async () => {
    vi.mocked(listBets)
      .mockResolvedValueOnce({ rows: [], total: 0 })
      .mockResolvedValueOnce({ rows: [], total: 0 });

    const result = await runAutoSettle();

    expect(result.scannedBets).toBe(0);
    expect(settleBatch).not.toHaveBeenCalled();
    expect(applySettlementOutcomes).not.toHaveBeenCalled();
  });

  it("passes resolved proposals through the shared settlement writer", async () => {
    const row = makeRow();
    vi.mocked(listBets).mockResolvedValue({ rows: [row as never], total: 1 });
    vi.mocked(settleBatch).mockResolvedValue({
      proposals: [
        {
          id: row.id,
          proposedOutcome: "won",
          confidence: 1,
          reasoning: "home win",
          score: "2-1",
          tier: "pure",
          source: "espn",
        },
      ],
      missing: [],
      eventBreakdown: eventBreakdown(),
      telemetry: mockTelemetry,
    });
    vi.mocked(applySettlementOutcomes).mockResolvedValue(1);

    const result = await runAutoSettle();

    expect(applySettlementOutcomes).toHaveBeenCalledWith([
      {
        id: row.id,
        outcome: "won",
        source: "espn",
        score: "2-1",
      },
    ]);
    expect(result.applied).toBe(1);
  });

  it("does not apply unresolved proposals", async () => {
    const row = makeRow();
    vi.mocked(listBets).mockResolvedValue({ rows: [row as never], total: 1 });
    vi.mocked(settleBatch).mockResolvedValue({
      proposals: [
        {
          id: row.id,
          proposedOutcome: "pending",
          confidence: 0,
          reasoning: "no score found",
          score: "",
          tier: "unresolved",
          source: null,
        },
      ],
      missing: [],
      eventBreakdown: eventBreakdown({
        networkAttemptedEventIds: ["evt1"],
        fullyResolvedEventIds: [],
        stillUnresolvedEventIds: ["evt1"],
      }),
      telemetry: {
        ...mockTelemetry,
        eventsAttempted: 1,
        eventsResolvedFromCache: 0,
        eventsStillUnresolved: 1,
        unresolved: 1,
        unresolvedEvents: 1,
        settledDeterministically: 0,
        unsupported: 1,
      },
    });

    const result = await runAutoSettle();

    expect(applySettlementOutcomes).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
    expect(result.stillPending).toBe(1);
  });

  it("routes mixed resolved rows in one shared batch", async () => {
    const placed = makeRow({
      id: "evt1|fam1|atom1",
      placedAt: "2026-01-01T12:30:00Z",
    });
    const unplaced = makeRow({
      id: "evt2|fam1|atom1",
      placedAt: null,
    });

    vi.mocked(listBets).mockResolvedValue({
      rows: [placed, unplaced] as never[],
      total: 2,
    });
    vi.mocked(settleBatch).mockResolvedValue({
      proposals: [
        {
          id: placed.id,
          proposedOutcome: "won",
          confidence: 1,
          reasoning: "",
          score: "1-0",
          tier: "pure",
          source: "espn",
        },
        {
          id: unplaced.id,
          proposedOutcome: "lost",
          confidence: 1,
          reasoning: "",
          score: "0-2",
          tier: "pure",
          source: "sofascore",
        },
      ],
      missing: [],
      eventBreakdown: eventBreakdown({
        fullyResolvedEventIds: ["evt1", "evt2"],
      }),
      telemetry: { ...mockTelemetry, total: 2 },
    });
    vi.mocked(applySettlementOutcomes).mockResolvedValue(2);

    await runAutoSettle();

    expect(applySettlementOutcomes).toHaveBeenCalledWith([
      {
        id: placed.id,
        outcome: "won",
        source: "espn",
        score: "1-0",
      },
      {
        id: unplaced.id,
        outcome: "lost",
        source: "sofascore",
        score: "0-2",
      },
    ]);
  });

  it("passes only retry-eligible events to network settlement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    const eligible = makeRow({
      id: "evt1|fam1|atom1",
      eventId: "evt1",
      settleAttempts: 1,
      lastSettleAttemptAt: "2026-01-01T22:30:00Z",
    });
    const backedOff = makeRow({
      id: "evt2|fam1|atom1",
      eventId: "evt2",
      settleAttempts: 1,
      lastSettleAttemptAt: "2026-01-01T23:30:00Z",
    });
    vi.mocked(listBets).mockResolvedValue({
      rows: [eligible, backedOff] as never[],
      total: 2,
    });
    vi.mocked(settleBatch).mockResolvedValue({
      proposals: [],
      missing: [],
      eventBreakdown: eventBreakdown({
        networkAttemptedEventIds: ["evt1"],
        skippedByBackoffEventIds: ["evt2"],
        fullyResolvedEventIds: [],
        stillUnresolvedEventIds: ["evt1", "evt2"],
      }),
      telemetry: {
        ...mockTelemetry,
        total: 2,
        eventsTotal: 2,
        eventsAttempted: 1,
        eventsResolvedFromCache: 0,
        eventsSkippedByBackoff: 1,
        eventsStillUnresolved: 2,
        unresolved: 2,
        unresolvedEvents: 2,
        settledDeterministically: 0,
      },
    });

    await runAutoSettle();

    const options = vi.mocked(settleBatch).mock.calls[0]?.[1];
    expect(options?.networkEventIds).toEqual(new Set(["evt1"]));
  });

  it("does not bump attempts for events skipped by retry backoff", async () => {
    const row = makeRow({
      settleAttempts: 1,
      lastSettleAttemptAt: new Date().toISOString(),
    });
    vi.mocked(listBets).mockResolvedValue({ rows: [row as never], total: 1 });
    vi.mocked(settleBatch).mockResolvedValue({
      proposals: [
        {
          id: row.id,
          proposedOutcome: "pending",
          confidence: 0,
          reasoning: "backoff",
          score: "",
          tier: "unresolved",
          source: null,
        },
      ],
      missing: [],
      eventBreakdown: eventBreakdown({
        skippedByBackoffEventIds: ["evt1"],
        fullyResolvedEventIds: [],
        stillUnresolvedEventIds: ["evt1"],
      }),
      telemetry: {
        ...mockTelemetry,
        eventsResolvedFromCache: 0,
        eventsSkippedByBackoff: 1,
        eventsStillUnresolved: 1,
        unresolved: 1,
        unresolvedEvents: 1,
        settledDeterministically: 0,
        unsupported: 1,
      },
    });

    await runAutoSettle();

    expect(recordSettleAttempts).toHaveBeenCalledWith([]);
  });

  it("sends source warning without stat copy for FT-only batches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-02T00:00:00Z"));
    const row = makeRow();
    vi.mocked(getApiFootballQuota).mockReturnValue({
      dailyLimit: 100,
      used: 90,
      remaining: 10,
    });
    vi.mocked(listBets).mockResolvedValue({ rows: [row as never], total: 1 });
    vi.mocked(settleBatch).mockResolvedValue({
      proposals: [
        {
          id: row.id,
          proposedOutcome: "pending",
          confidence: 0,
          reasoning: "no source",
          score: "",
          tier: "unresolved",
          source: null,
        },
      ],
      missing: [],
      eventBreakdown: eventBreakdown({
        networkAttemptedEventIds: ["evt1"],
        fullyResolvedEventIds: [],
        stillUnresolvedEventIds: ["evt1"],
      }),
      telemetry: {
        ...mockTelemetry,
        eventsAttempted: 1,
        eventsResolvedFromCache: 0,
        eventsStillUnresolved: 1,
        apiFootballRequestsUsed: 6,
        unresolved: 1,
        unresolvedEvents: 1,
        settledDeterministically: 0,
        unsupported: 1,
      },
    });

    await runAutoSettle();

    const message = vi.mocked(notify).mock.calls[0]?.[0].message ?? "";
    expect(message).toContain("Settlement sources need attention");
    expect(message).toContain(
      "Outcome: 1 event still unresolved; 0 events resolved this tick.",
    );
    expect(message).toContain(
      "Queue: 1 bet across 1 event. Tried 1; backoff held 0.",
    );
    expect(message).toContain("API-Football: 10/100 left; used 6 this tick.");
    expect(message).toContain(
      "Waterfall: ESPN → SofaScore → API-Football.",
    );
    expect(message).not.toContain("Corners markets");
    expect(message).not.toContain("Bookings markets");
    expect(message).not.toContain("1H/2H markets");
  });

  it("includes concrete source issues in source warnings", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-02-02T00:00:00Z"));
    const row = makeRow();
    vi.mocked(listBets).mockResolvedValue({ rows: [row as never], total: 1 });
    vi.mocked(settleBatch).mockResolvedValue({
      proposals: [
        {
          id: row.id,
          proposedOutcome: "pending",
          confidence: 0,
          reasoning: "no source",
          score: "",
          tier: "unresolved",
          source: null,
        },
      ],
      missing: [],
      eventBreakdown: eventBreakdown({
        networkAttemptedEventIds: ["evt1"],
        fullyResolvedEventIds: [],
        stillUnresolvedEventIds: ["evt1"],
      }),
      telemetry: {
        ...mockTelemetry,
        eventsAttempted: 1,
        eventsResolvedFromCache: 0,
        eventsStillUnresolved: 1,
        unresolved: 1,
        unresolvedEvents: 1,
        settledDeterministically: 0,
        unsupported: 1,
        sourceIssues: [
          "API-Football access issue on /fixtures: plan: Free plans do not have access to this date.",
        ],
      },
    });

    await runAutoSettle();

    const message = vi.mocked(notify).mock.calls[0]?.[0].message ?? "";
    expect(message).toContain("Blocked by:");
    expect(message).toContain(
      "- API-Football: plan: Free plans do not have access to this date.",
    );
  });

  it("includes stat-market copy in source warnings only when those markets are present", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2028-01-02T00:00:00Z"));
    const corners = makeRow({
      id: "evt1|fam1|atom1",
      eventId: "evt1",
      marketType: "CORNERS",
    });
    const bookings = makeRow({
      id: "evt2|fam1|atom1",
      eventId: "evt2",
      marketType: "BOOKINGS",
    });
    vi.mocked(getApiFootballQuota).mockReturnValue({
      dailyLimit: 100,
      used: 90,
      remaining: 10,
    });
    vi.mocked(listBets).mockResolvedValue({
      rows: [corners, bookings] as never[],
      total: 2,
    });
    vi.mocked(settleBatch).mockResolvedValue({
      proposals: [
        {
          id: corners.id,
          proposedOutcome: "pending",
          confidence: 0,
          reasoning: "no corners",
          score: "2-1",
          tier: "unresolved",
          source: "espn",
        },
        {
          id: bookings.id,
          proposedOutcome: "pending",
          confidence: 0,
          reasoning: "no bookings",
          score: "2-1",
          tier: "unresolved",
          source: "espn",
        },
      ],
      missing: [],
      eventBreakdown: eventBreakdown({
        networkAttemptedEventIds: ["evt1", "evt2"],
        fullyResolvedEventIds: [],
        stillUnresolvedEventIds: ["evt1", "evt2"],
      }),
      telemetry: {
        ...mockTelemetry,
        total: 2,
        eventsTotal: 2,
        eventsAttempted: 2,
        eventsResolvedFromCache: 0,
        eventsStillUnresolved: 2,
        unresolved: 2,
        unresolvedEvents: 2,
        settledDeterministically: 0,
        unsupported: 2,
      },
    });

    await runAutoSettle();

    const message = vi.mocked(notify).mock.calls[0]?.[0].message ?? "";
    expect(message).toContain("Needs: corner stats, booking points.");
    expect(message).not.toContain("1H/2H markets");
  });
});
