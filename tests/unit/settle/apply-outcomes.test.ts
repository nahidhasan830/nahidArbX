import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/repositories/bets", () => ({
  getBetsByIds: vi.fn(),
  markOutcomesBulk: vi.fn(),
  applySettlement: vi.fn(),
}));

vi.mock("@/lib/notifier", () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/betting/registry", () => ({
  getBettingProvider: vi.fn().mockReturnValue({
    providerDisplayName: "9W Sportsbook",
  }),
}));

vi.mock("@/lib/shared/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { applySettlementOutcomes } from "@/lib/settle/apply-outcomes";
import {
  applySettlement,
  getBetsByIds,
  markOutcomesBulk,
} from "@/lib/db/repositories/bets";
import { notify } from "@/lib/notifier";

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
    softProvider: "ninewickets-sportsbook",
    softOdds: 2.1,
    softCommissionPct: 0,
    sharpProvider: "pinnacle",
    sharpOdds: 2.0,
    sharpTrueProb: 0.5,
    firstSeenAt: "2026-01-01T12:00:00Z",
    lastSeenAt: "2026-01-01T12:00:00Z",
    tickCount: 1,
    placedAt: null,
    provider: null,
    stake: null,
    odds: null,
    currency: "BDT",
    outcome: "pending",
    settledAt: null,
    pnl: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(markOutcomesBulk).mockResolvedValue(0);
  vi.mocked(applySettlement).mockResolvedValue(null);
  vi.mocked(notify).mockResolvedValue(undefined);
});

describe("applySettlementOutcomes", () => {
  it("marks unplaced rows silently", async () => {
    const row = makeRow({ placedAt: null });
    vi.mocked(getBetsByIds).mockResolvedValue([row as never]);
    vi.mocked(markOutcomesBulk).mockResolvedValue(1);

    const applied = await applySettlementOutcomes([
      { id: row.id, outcome: "won", source: "espn", score: "2-1" },
    ]);

    expect(markOutcomesBulk).toHaveBeenCalledWith([
      { id: row.id, outcome: "won", source: "espn" },
    ]);
    expect(applySettlement).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(applied).toBe(1);
  });

  it("settles placed rows with notification side effects", async () => {
    const row = makeRow({
      placedAt: "2026-01-01T12:30:00Z",
      provider: "ninewickets-sportsbook",
      stake: 250,
      odds: 2.1,
    });
    const settled = {
      ...row,
      outcome: "won",
      settledAt: "2026-01-01T17:30:00Z",
      pnl: 275,
    };
    vi.mocked(getBetsByIds).mockResolvedValue([row as never]);
    vi.mocked(applySettlement).mockResolvedValue(settled as never);

    const applied = await applySettlementOutcomes([
      { id: row.id, outcome: "won", source: "sofascore", score: "2-1" },
    ]);

    expect(markOutcomesBulk).not.toHaveBeenCalled();
    expect(applySettlement).toHaveBeenCalledWith({
      betId: row.id,
      outcome: "won",
      settledBySource: "sofascore",
    });
    expect(notify).toHaveBeenCalledOnce();
    const event = vi.mocked(notify).mock.calls[0][0];
    expect(event.type).toBe("bet:settled");
    if (event.type === "bet:settled") {
      expect(event.settledBySource).toBe("sofascore");
      expect(event.matchScore).toEqual({ status: "FT", ftHome: 2, ftAway: 1 });
      expect(event.pnl).toBe(275);
    }
    expect(applied).toBe(1);
  });

  it("routes mixed placed and unplaced rows through the same helper", async () => {
    const placed = makeRow({
      id: "evt1|fam1|atom1",
      placedAt: "2026-01-01T12:30:00Z",
      provider: "ninewickets-sportsbook",
      stake: 200,
      odds: 2.0,
    });
    const unplaced = makeRow({
      id: "evt2|fam1|atom1",
      placedAt: null,
    });
    vi.mocked(getBetsByIds).mockResolvedValue([placed, unplaced] as never[]);
    vi.mocked(markOutcomesBulk).mockResolvedValue(1);
    vi.mocked(applySettlement).mockResolvedValue({
      ...placed,
      outcome: "won",
      settledAt: "2026-01-01T17:30:00Z",
      pnl: 200,
    } as never);

    const applied = await applySettlementOutcomes([
      { id: placed.id, outcome: "won", source: "espn", score: "1-0" },
      { id: unplaced.id, outcome: "lost", source: "espn", score: "0-2" },
    ]);

    expect(markOutcomesBulk).toHaveBeenCalledOnce();
    expect(applySettlement).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(applied).toBe(2);
  });
});
