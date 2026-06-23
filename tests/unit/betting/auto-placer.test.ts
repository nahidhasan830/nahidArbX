import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/betting/auto-place-config", () => ({
  isAutoPlaceEnabled: vi.fn(),
}));

vi.mock("@/lib/betting/registry", () => ({
  getBettingProvider: vi.fn(),
}));

vi.mock("@/lib/betting/placer", () => ({
  placeBetForValueBet: vi.fn(),
}));

vi.mock("@/lib/db/repositories/bets", () => ({
  getBetById: vi.fn(),
  hasPlacedSiblingInFamily: vi.fn(),
}));

vi.mock("@/lib/shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/db/repositories/auto-placer-log", () => ({
  recordDecision: vi.fn(),
}));

vi.mock("@/lib/db/repositories/betting-settings", () => ({
  getBettingSettings: vi.fn(),
}));

import { maybeAutoPlace } from "@/lib/betting/auto-placer";
import { isAutoPlaceEnabled } from "@/lib/betting/auto-place-config";
import { getBettingProvider } from "@/lib/betting/registry";
import { placeBetForValueBet } from "@/lib/betting/placer";
import {
  getBetById,
  hasPlacedSiblingInFamily,
} from "@/lib/db/repositories/bets";
import { recordDecision } from "@/lib/db/repositories/auto-placer-log";
import { getBettingSettings } from "@/lib/db/repositories/betting-settings";

const ML_ALLOWED = {
  permissionLevel: "gate_only" as const,
  mlScore: 0.8,
  mlKellyMultiplier: 1,
};

function makeValueBet(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt1|fam1|atom1",
    eventId: "evt1",
    familyId: "fam1",
    atomId: "ft_home_win",
    sharpProvider: "pinnacle" as const,
    sharpOdds: 2.0,
    trueProb: 0.5,
    trueOdds: 2.0,
    softProvider: "ninewickets-sportsbook" as const,
    softOdds: 2.15,
    adjustedSoftOdds: 2.15,
    impliedProb: 0.465,
    commissionPct: 0,
    evPct: 7.5,
    edge: 0.075,
    kellyFraction: 0.25,
    kellyStake: 250,
    detectedAt: new Date(),
    timestamp: Date.now(),
    ...overrides,
  };
}

const mockAdapter = {
  providerId: "ninewickets-sportsbook",
  providerDisplayName: "9W Sportsbook",
};
const mockRow = {
  id: "evt1|fam1|atom1",
  eventId: "evt1",
  familyId: "fam1",
  atomId: "ft_home_win",
  atomLabel: "Home Win",
  homeTeam: "Home",
  awayTeam: "Away",
  competition: "Test League",
  eventStartTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  marketType: "MATCH_RESULT",
  softProvider: "ninewickets-sportsbook",
  softOdds: 2.15,
  sharpOdds: 2,
  outcome: "pending",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBettingSettings).mockResolvedValue({
    row: {
      mlMinScore: 0.4,
      valueDetectionPhases: ["pre_match"],
      betPlacementPhases: ["pre_match"],
    },
  } as never);
  vi.mocked(hasPlacedSiblingInFamily).mockResolvedValue(false);
});

describe("maybeAutoPlace — toggle OFF", () => {
  it("returns without calling placer when auto-place is disabled", async () => {
    vi.mocked(isAutoPlaceEnabled).mockReturnValue(false);
    await maybeAutoPlace(makeValueBet() as never);
    expect(placeBetForValueBet).not.toHaveBeenCalled();
  });
});

describe("maybeAutoPlace — no registered adapter", () => {
  it("returns without calling placer when provider has no adapter", async () => {
    vi.mocked(isAutoPlaceEnabled).mockReturnValue(true);
    vi.mocked(getBettingProvider).mockReturnValue(null);
    await maybeAutoPlace(makeValueBet() as never);
    expect(placeBetForValueBet).not.toHaveBeenCalled();
  });
});

describe("maybeAutoPlace — bet row not found post-persist", () => {
  it("returns without calling placer when DB row is missing", async () => {
    vi.mocked(isAutoPlaceEnabled).mockReturnValue(true);
    vi.mocked(getBettingProvider).mockReturnValue(mockAdapter as never);
    vi.mocked(getBetById).mockResolvedValue(null);
    await maybeAutoPlace(makeValueBet() as never, ML_ALLOWED);
    expect(placeBetForValueBet).not.toHaveBeenCalled();
  });
});

describe("maybeAutoPlace — happy path", () => {
  beforeEach(() => {
    vi.mocked(isAutoPlaceEnabled).mockReturnValue(true);
    vi.mocked(getBettingProvider).mockReturnValue(mockAdapter as never);
    vi.mocked(getBetById).mockResolvedValue(mockRow as never);
    vi.mocked(placeBetForValueBet).mockResolvedValue({
      status: "placed",
    } as never);
  });

  it("calls placeBetForValueBet with mode auto", async () => {
    const vb = makeValueBet();
    await maybeAutoPlace(vb as never, ML_ALLOWED);
    expect(placeBetForValueBet).toHaveBeenCalledOnce();
    const args = vi.mocked(placeBetForValueBet).mock.calls[0][0];
    expect(args.mode).toBe("auto");
    expect(args.kellyStake).toBe(vb.kellyStake);
    expect(args.mlScore).toBe(0.8);
  });

  it("logs the placement outcome", async () => {
    const { logger } = await import("@/lib/shared/logger");
    await maybeAutoPlace(makeValueBet() as never, ML_ALLOWED);
    expect(logger.info).toHaveBeenCalled();
  });
});

describe("maybeAutoPlace — placer returns skipped/rejected", () => {
  it("logs the skip reason without throwing", async () => {
    vi.mocked(isAutoPlaceEnabled).mockReturnValue(true);
    vi.mocked(getBettingProvider).mockReturnValue(mockAdapter as never);
    vi.mocked(getBetById).mockResolvedValue(mockRow as never);
    vi.mocked(placeBetForValueBet).mockResolvedValue({
      status: "skipped",
      reason: "already_placed",
    } as never);

    const { logger } = await import("@/lib/shared/logger");
    await expect(
      maybeAutoPlace(makeValueBet() as never, ML_ALLOWED),
    ).resolves.not.toThrow();
    expect(logger.info).toHaveBeenCalled();
  });
});

describe("maybeAutoPlace — ML Kelly multiplier pass-through", () => {
  beforeEach(() => {
    vi.mocked(isAutoPlaceEnabled).mockReturnValue(true);
    vi.mocked(getBettingProvider).mockReturnValue(mockAdapter as never);
    vi.mocked(getBetById).mockResolvedValue(mockRow as never);
    vi.mocked(placeBetForValueBet).mockResolvedValue({
      status: "placed",
    } as never);
  });

  it("passes mlKellyMultiplier to placer when provided", async () => {
    const vb = makeValueBet();
    await maybeAutoPlace(vb as never, {
      ...ML_ALLOWED,
      mlKellyMultiplier: 0.7,
      mlModelVersion: 12,
      mlFeatures: [0.1, 2.15],
      mlFeatureVersion: 1,
      mlFeatureCount: 2,
      mlFeatureNamesHash: "feature-hash",
    });
    const args = vi.mocked(placeBetForValueBet).mock.calls[0][0];
    expect(args.mlKellyMultiplier).toBe(0.7);
    expect(args.mlModelVersion).toBe(12);
    expect(args.mlFeatures).toEqual([0.1, 2.15]);
    expect(args.mlFeatureVersion).toBe(1);
    expect(args.mlFeatureCount).toBe(2);
    expect(args.mlFeatureNamesHash).toBe("feature-hash");
    expect(args.kellyStake).toBe(vb.kellyStake);
  });

  it("requires an ML gate decision before placement", async () => {
    await maybeAutoPlace(makeValueBet() as never, {
      permissionLevel: "gate_only",
      mlScore: 0.8,
    });
    expect(placeBetForValueBet).not.toHaveBeenCalled();
  });

  it("uses base kellyStake regardless of ML multiplier", async () => {
    const vb = makeValueBet({ kellyStake: 500 });
    await maybeAutoPlace(vb as never, {
      ...ML_ALLOWED,
      mlKellyMultiplier: 0.5,
    });
    const args = vi.mocked(placeBetForValueBet).mock.calls[0][0];
    expect(args.kellyStake).toBe(500);
  });
});

describe("maybeAutoPlace — ML score gating", () => {
  beforeEach(() => {
    vi.mocked(isAutoPlaceEnabled).mockReturnValue(true);
    vi.mocked(getBettingProvider).mockReturnValue(mockAdapter as never);
    vi.mocked(getBetById).mockResolvedValue(mockRow as never);
  });

  it("passes through baseline placement in observe mode", async () => {
    vi.mocked(placeBetForValueBet).mockResolvedValue({
      status: "placed",
    } as never);

    await maybeAutoPlace(makeValueBet() as never, {
      permissionLevel: "observe",
      mlScore: 0.9,
      mlKellyMultiplier: 1.8,
    });

    expect(placeBetForValueBet).toHaveBeenCalledOnce();
    const args = vi.mocked(placeBetForValueBet).mock.calls[0][0];
    expect(args.mode).toBe("auto");
    expect(args.mlScore).toBe(0.9);
    expect(args.mlKellyMultiplier).toBeNull();
  });

  it("passes through baseline placement with no model/options", async () => {
    vi.mocked(placeBetForValueBet).mockResolvedValue({
      status: "placed",
    } as never);

    await maybeAutoPlace(makeValueBet() as never);

    expect(placeBetForValueBet).toHaveBeenCalledOnce();
    const args = vi.mocked(placeBetForValueBet).mock.calls[0][0];
    expect(args.mlScore).toBeNull();
    expect(args.mlKellyMultiplier).toBeNull();
  });

  it("skips placement when active ML permission has no score", async () => {
    await maybeAutoPlace(makeValueBet() as never, {
      permissionLevel: "gate_only",
      mlScore: null,
    });

    expect(placeBetForValueBet).not.toHaveBeenCalled();
    expect(recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: "ml_score",
        status: "skipped",
        reason:
          "ML score unavailable; active ML permission requires a scored bet",
      }),
    );
  });

  it("skips placement when ML model edge is not positive", async () => {
    await maybeAutoPlace(makeValueBet() as never, {
      permissionLevel: "gate_only",
      mlScore: 0.8,
      mlKellyMultiplier: 0,
    });
    expect(placeBetForValueBet).not.toHaveBeenCalled();
  });

  it("proceeds when permission is gate_only and ML edge passes", async () => {
    vi.mocked(placeBetForValueBet).mockResolvedValue({
      status: "placed",
    } as never);
    await maybeAutoPlace(makeValueBet() as never, ML_ALLOWED);
    expect(placeBetForValueBet).toHaveBeenCalledOnce();
  });

  it("skips active ML placement when a sibling in the same family is already placed", async () => {
    vi.mocked(hasPlacedSiblingInFamily).mockResolvedValue(true);

    await maybeAutoPlace(makeValueBet() as never, ML_ALLOWED);

    expect(placeBetForValueBet).not.toHaveBeenCalled();
    expect(recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: "ml_family",
        status: "skipped",
        reason:
          "ML family deconfliction: another selection in this event/market is already reserved or placed",
      }),
    );
  });

  it("does not apply family deconfliction in observe mode", async () => {
    vi.mocked(hasPlacedSiblingInFamily).mockResolvedValue(true);
    vi.mocked(placeBetForValueBet).mockResolvedValue({
      status: "placed",
    } as never);

    await maybeAutoPlace(makeValueBet() as never, {
      permissionLevel: "observe",
      mlScore: 0.8,
      mlKellyMultiplier: 1,
    });

    expect(hasPlacedSiblingInFamily).not.toHaveBeenCalled();
    expect(placeBetForValueBet).toHaveBeenCalledOnce();
  });
});

describe("maybeAutoPlace — market phase gating", () => {
  beforeEach(() => {
    vi.mocked(isAutoPlaceEnabled).mockReturnValue(true);
    vi.mocked(getBettingProvider).mockReturnValue(mockAdapter as never);
    vi.mocked(getBetById).mockResolvedValue({
      ...mockRow,
      eventStartTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    } as never);
  });

  it("skips when bet placement is disabled for the event phase", async () => {
    vi.mocked(getBettingSettings).mockResolvedValue({
      row: {
        mlMinScore: 0.4,
        valueDetectionPhases: ["pre_match"],
        betPlacementPhases: ["in_play"],
      },
    } as never);

    await maybeAutoPlace(makeValueBet() as never, ML_ALLOWED);

    expect(placeBetForValueBet).not.toHaveBeenCalled();
    expect(recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        gate: "phase",
        status: "skipped",
        reason: "Bet placement disabled for Pre-Match events",
      }),
    );
  });
});
