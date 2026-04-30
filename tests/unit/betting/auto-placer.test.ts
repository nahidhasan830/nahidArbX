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
}));

vi.mock("@/lib/shared/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { maybeAutoPlace } from "@/lib/betting/auto-placer";
import { isAutoPlaceEnabled } from "@/lib/betting/auto-place-config";
import { getBettingProvider } from "@/lib/betting/registry";
import { placeBetForValueBet } from "@/lib/betting/placer";
import { getBetById } from "@/lib/db/repositories/bets";

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
const mockRow = { id: "evt1|fam1|atom1", outcome: "pending" };

beforeEach(() => {
  vi.clearAllMocks();
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
    await maybeAutoPlace(makeValueBet() as never);
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
    await maybeAutoPlace(vb as never);
    expect(placeBetForValueBet).toHaveBeenCalledOnce();
    const args = vi.mocked(placeBetForValueBet).mock.calls[0][0];
    expect(args.mode).toBe("auto");
    expect(args.kellyStake).toBe(vb.kellyStake);
  });

  it("logs the placement outcome", async () => {
    const { logger } = await import("@/lib/shared/logger");
    await maybeAutoPlace(makeValueBet() as never);
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
      maybeAutoPlace(makeValueBet() as never),
    ).resolves.not.toThrow();
    expect(logger.info).toHaveBeenCalled();
  });
});
