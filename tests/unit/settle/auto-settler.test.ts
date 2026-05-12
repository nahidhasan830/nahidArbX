import { beforeEach, describe, expect, it, vi } from "vitest";

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

const mockTelemetry = {
  total: 1,
  tier0_hits: 1,
  tier1_hits: 0,
  tier2_hits: 0,
  tier3_hits: 0,
  tier4_hits: 0,
  unresolved: 0,
  durationMs: 10,
  sourceIssues: [],
  settledDeterministically: 1,
  unsupported: 0,
  unresolvedEvents: 0,
};

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
      telemetry: {
        ...mockTelemetry,
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
});
