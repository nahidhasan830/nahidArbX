
import { describe, it, expect, beforeEach, vi } from "vitest";
import { FEATURE_INDEX } from "@/lib/ml/feature-contract";

const historyStore = new Map<
  string,
  {
    ticks: { odds: number; timestamp: number; suspended: boolean }[];
    cursor: number;
    totalTicks: number;
    openingOdds: number | null;
    openingTimestamp: number | null;
    peakOdds: number;
    troughOdds: number;
  }
>();

const oddsAtomStore = new Map<
  string,
  Map<string, { odds: number; timestamp: number; suspended?: boolean }>
>();

const eventStore = new Map<
  string,
  {
    id: string;
    startTime: Date;
    homeTeam: string;
    awayTeam: string;
    competition?: string;
  }
>();

const familyStore = new Map<
  string,
  {
    id: string;
    type: string;
    time_scope: string;
    market_type: string;
    line?: number;
    atoms: string[];
  }
>();

const vigCache = new Map<
  string,
  { vigPct: number; familyId: string; provider: string } | null
>();

function makeHistoryKey(
  eventId: string,
  familyId: string,
  atomId: string,
  provider: string,
): string {
  return `${eventId}|${familyId}|${atomId}|${provider}`;
}

function makeAtomKey(
  eventId: string,
  familyId: string,
  atomId: string,
): string {
  return `${eventId}|${familyId}|${atomId}`;
}

vi.mock("@/lib/atoms/odds-history", () => ({
  getAtomHistory: (
    eventId: string,
    familyId: string,
    atomId: string,
    provider: string,
  ) =>
    historyStore.get(makeHistoryKey(eventId, familyId, atomId, provider)) ??
    null,
  getOrderedTicks: (
    eventId: string,
    familyId: string,
    atomId: string,
    provider: string,
  ) => {
    const hist = historyStore.get(
      makeHistoryKey(eventId, familyId, atomId, provider),
    );
    if (!hist) return [];
    return hist.ticks.filter(
      (t: { odds: number; timestamp: number; suspended: boolean }) => t != null,
    );
  },
  detectSteamMove: () => null,
  getMovementSummary: () => null,
  recordOddsTick: () => {},
}));

vi.mock("@/lib/atoms/store", () => ({
  getAllOddsForAtom: (eventId: string, familyId: string, atomId: string) =>
    oddsAtomStore.get(makeAtomKey(eventId, familyId, atomId)) ?? new Map(),
  getFamiliesForEvent: () => [],
  parseDirtyKey: () => ({ eventId: "", familyId: "" }),
}));

vi.mock("@/lib/atoms/registry", () => ({
  getFamily: (familyId: string) => familyStore.get(familyId),
}));

vi.mock("@/lib/atoms/value-detector", () => ({
  getCachedVigData: (eventId: string, familyId: string) =>
    vigCache.get(`${eventId}|${familyId}`),
}));

vi.mock("@/lib/providers/registry", () => ({
  getProviderCommission: (provider: string) => {
    if (provider === "ninewickets-exchange") return 5;
    return 0;
  },
}));

vi.mock("@/lib/store", () => ({
  getEvent: (eventId: string) => eventStore.get(eventId),
}));

import {
  extractFeatures,
  extractHistoricalFeatures,
  normalizeHistoricalOddsMovement,
  FEATURE_NAMES,
  FEATURE_COUNT,
  FEATURE_NAMES_HASH,
  FEATURE_VERSION,
  isFeatureWarm,
} from "@/lib/ml/features";
import { ML_FEATURE_COUNT, ML_FEATURE_VERSION } from "@/lib/shared/constants";
import { computeConvergenceRate } from "@/lib/ml/convergence";

function makeSyntheticValueBet(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: "evt1|ft_match_result|ft_1x2_home",
    eventId: "evt1",
    familyId: "ft_match_result",
    atomId: "ft_1x2_home",
    sharpProvider: "pinnacle",
    sharpOdds: 2.1,
    trueProb: 0.48,
    trueOdds: 2.0833,
    softProvider: "ninewickets-exchange",
    softOdds: 2.25,
    adjustedSoftOdds: 2.1375,
    impliedProb: 0.4678,
    commissionPct: 5,
    evPct: 2.6,
    edge: 0.026,
    kellyFraction: 0.0229,
    kellyStake: 22.86,
    detectedAt: new Date(now),
    timestamp: now - 500,
    ...overrides,
  } as Parameters<typeof extractFeatures>[0];
}

describe("FEATURE_NAMES", () => {
  it("has exactly 22 entries", () => {
    expect(FEATURE_NAMES).toHaveLength(22);
    expect(FEATURE_COUNT).toBe(22);
  });

  it("has unique entries", () => {
    const unique = new Set(FEATURE_NAMES);
    expect(unique.size).toBe(22);
  });

  it("starts with sharp_true_prob and ends with num_markets_same_event", () => {
    expect(FEATURE_NAMES[0]).toBe("sharp_true_prob");
    expect(FEATURE_NAMES[21]).toBe("num_markets_same_event");
  });

  it("matches shared ML feature constants", () => {
    expect(FEATURE_COUNT).toBe(ML_FEATURE_COUNT);
    expect(FEATURE_VERSION).toBe(ML_FEATURE_VERSION);
    expect(FEATURE_NAMES_HASH).toHaveLength(64);
  });
});

describe("extractFeatures", () => {
  beforeEach(() => {
    historyStore.clear();
    oddsAtomStore.clear();
    eventStore.clear();
    familyStore.clear();
    vigCache.clear();
  });

  it("returns a 22-element number array", () => {
    const features = extractFeatures(makeSyntheticValueBet());

    expect(features).toHaveLength(22);
    for (let i = 0; i < 22; i++) {
      expect(typeof features[i]).toBe("number");
      expect(Number.isNaN(features[i])).toBe(false);
    }
  });

  it("correctly extracts core value-bet fields", () => {
    const features = extractFeatures(makeSyntheticValueBet());

    expect(features[FEATURE_INDEX.sharp_true_prob]).toBe(0.48);
    expect(features[FEATURE_INDEX.soft_odds]).toBe(2.25);
    expect(features[FEATURE_INDEX.adjusted_soft_odds]).toBe(2.1375);
    expect(features[FEATURE_INDEX.sharp_soft_spread]).toBeCloseTo(0.1667, 4);
  });

  it("rounds all values to 4 decimal places", () => {
    const features = extractFeatures(
      makeSyntheticValueBet({
        trueProb: 0.4812345,
        adjustedSoftOdds: 2.13754321,
      }),
    );

    expect(features[FEATURE_INDEX.sharp_true_prob]).toBe(0.4812);
    expect(features[FEATURE_INDEX.adjusted_soft_odds]).toBe(2.1375);
  });

  it("uses event startTime for time_to_kickoff_min", () => {
    const futureKickoff = new Date(Date.now() + 60 * 60 * 1000);
    eventStore.set("evt1", {
      id: "evt1",
      startTime: futureKickoff,
      homeTeam: "Team A",
      awayTeam: "Team B",
    });

    const features = extractFeatures(makeSyntheticValueBet());

    expect(features[FEATURE_INDEX.time_to_kickoff_min]).toBeGreaterThanOrEqual(
      59,
    );
    expect(features[FEATURE_INDEX.time_to_kickoff_min]).toBeLessThanOrEqual(61);
  });

  it("encodes market type as ordinal", () => {
    familyStore.set("ft_match_result", {
      id: "ft_match_result",
      type: "group",
      time_scope: "FT",
      market_type: "MATCH_RESULT",
      atoms: ["ft_1x2_home", "ft_1x2_draw", "ft_1x2_away"],
    });

    const features = extractFeatures(makeSyntheticValueBet());

    expect(features[FEATURE_INDEX.market_type_encoded]).toBe(0);
  });

  it("detects asian line correctly", () => {
    familyStore.set("ft_match_result", {
      id: "ft_match_result",
      type: "pair",
      time_scope: "FT",
      market_type: "ASIAN_HANDICAP",
      line: 0.25,
      atoms: ["ft_ah_home", "ft_ah_away"],
    });

    const features = extractFeatures(makeSyntheticValueBet());

    expect(features[FEATURE_INDEX.is_asian_line]).toBe(1);
  });

  it("reads vig from cached vig data", () => {
    vigCache.set("evt1|ft_match_result", {
      vigPct: 4.5,
      familyId: "ft_match_result",
      provider: "pinnacle",
    });

    const features = extractFeatures(makeSyntheticValueBet());

    expect(features[FEATURE_INDEX.vig_pct]).toBe(4.5);
  });

  it("uses non-fake defaults for missing metadata", () => {
    const features = extractFeatures(makeSyntheticValueBet());

    expect(features[FEATURE_INDEX.tick_count]).toBe(0);
    expect(features[FEATURE_INDEX.time_to_kickoff_min]).toBe(0);
    expect(features[FEATURE_INDEX.convergence_rate]).toBe(0);
    expect(features[FEATURE_INDEX.opening_sharp_odds]).toBe(0);
    expect(features[FEATURE_INDEX.vig_pct]).toBe(0);
    expect(features[FEATURE_INDEX.competition_tier]).toBe(1);
    expect(features[FEATURE_INDEX.hours_since_line_opened]).toBe(0);
    expect(features[FEATURE_INDEX.num_markets_same_event]).toBe(1);
  });

  it("computes provider_count from odds store", () => {
    const atomKey = makeAtomKey("evt1", "ft_match_result", "ft_1x2_home");
    const providers = new Map();
    providers.set("pinnacle", { odds: 2.1, timestamp: Date.now() });
    providers.set("ninewickets-exchange", {
      odds: 2.25,
      timestamp: Date.now(),
    });
    providers.set("velki-sportsbook", { odds: 2.2, timestamp: Date.now() });
    oddsAtomStore.set(atomKey, providers);

    const features = extractFeatures(makeSyntheticValueBet());

    expect(features[FEATURE_INDEX.provider_count]).toBe(3);
  });

  it("clamps impossible derived values", () => {
    const now = Date.now();
    const sharpKey = makeHistoryKey(
      "evt1",
      "ft_match_result",
      "ft_1x2_home",
      "pinnacle",
    );
    historyStore.set(sharpKey, {
      ticks: [],
      cursor: 0,
      totalTicks: 0,
      openingOdds: 2,
      openingTimestamp: now + 60_000,
      peakOdds: 2,
      troughOdds: 2,
    });

    const features = extractFeatures(makeSyntheticValueBet({ trueProb: 0 }), 0);

    expect(features[FEATURE_INDEX.hours_since_line_opened]).toBe(0);
    expect(features[FEATURE_INDEX.sharp_soft_spread]).toBe(0);
    expect(features[FEATURE_INDEX.num_markets_same_event]).toBe(1);
  });
});

describe("historical feature helpers", () => {
  beforeEach(() => {
    historyStore.clear();
    oddsAtomStore.clear();
    eventStore.clear();
    familyStore.clear();
    vigCache.clear();
  });

  it("normalizes legacy single-provider oddsMovement blobs", () => {
    const normalized = normalizeHistoricalOddsMovement({
      provider: "pinnacle",
      openingOdds: 2,
      peakOdds: 2.1,
      troughOdds: 1.9,
      totalTicks: 3,
      sparkline: [
        [1000, 2],
        [2000, 2.05],
        [3000, 2.02],
      ],
    });

    expect(Object.keys(normalized)).toEqual(["pinnacle"]);
    expect(normalized.pinnacle?.openingOdds).toBe(2);
  });

  it("skips rows without persisted movement snapshots", () => {
    const result = extractHistoricalFeatures({
      eventStartTime: new Date("2026-05-22T15:00:00Z"),
      firstSeenAt: new Date("2026-05-22T14:00:00Z"),
      competition: "Premier League",
      marketType: "MATCH_RESULT",
      familyLine: null,
      sharpProvider: "pinnacle",
      sharpOdds: 2.1,
      sharpTrueProb: 0.48,
      softProvider: "ninewickets-exchange",
      softCommissionPct: 5,
      softOdds: 2.25,
      oddsMovement: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected skip result");
    expect(result.reasons).toContain("missing_odds_movement");
    expect(result.reasons).toContain("missing_sharp_snapshot");
    expect(result.reasons).toContain("missing_soft_snapshot");
  });

  it("builds a 22-feature vector from persisted fields", () => {
    const now = Date.now();
    const opening = now - 2 * 60 * 60 * 1000;
    const firstSeenAt = new Date(now - 60 * 60 * 1000);
    const result = extractHistoricalFeatures({
      eventStartTime: new Date(now + 2 * 60 * 60 * 1000),
      firstSeenAt,
      competition: "Premier League",
      marketType: "MATCH_RESULT",
      familyLine: 0.25,
      sharpProvider: "pinnacle",
      sharpOdds: 2.1,
      sharpTrueProb: 0.48,
      softProvider: "ninewickets-exchange",
      softCommissionPct: 5,
      softOdds: 2.25,
      oddsMovement: {
        pinnacle: {
          provider: "pinnacle",
          openingOdds: 2,
          peakOdds: 2.05,
          troughOdds: 1.98,
          totalTicks: 3,
          sparkline: [
            [opening, 2],
            [opening + 30 * 60 * 1000, 2.05],
            [opening + 60 * 60 * 1000, 2.02],
          ],
        },
        "ninewickets-exchange": {
          provider: "ninewickets-exchange",
          openingOdds: 2.3,
          peakOdds: 2.3,
          troughOdds: 2.2,
          totalTicks: 3,
          sparkline: [
            [opening, 2.3],
            [opening + 30 * 60 * 1000, 2.27],
            [opening + 60 * 60 * 1000, 2.25],
          ],
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected reconstructed features");
    expect(result.features).toHaveLength(22);
    expect(result.features[FEATURE_INDEX.provider_count]).toBe(2);
    expect(result.features[FEATURE_INDEX.vig_pct]).toBeCloseTo(-0.7937, 4);
    expect(result.features[FEATURE_INDEX.hours_since_line_opened]).toBeCloseTo(
      1,
      4,
    );
    expect(result.features[FEATURE_INDEX.num_markets_same_event]).toBe(1);
    expect(result.features[FEATURE_INDEX.is_asian_line]).toBe(1);
  });
});

describe("isFeatureWarm", () => {
  it("returns false when tick_count is 0", () => {
    const features = new Array(FEATURE_COUNT).fill(0);
    features[FEATURE_INDEX.tick_count] = 0;
    expect(isFeatureWarm(features)).toBe(false);
  });

  it("returns false when tick_count is below threshold", () => {
    const features = new Array(FEATURE_COUNT).fill(0);
    features[FEATURE_INDEX.tick_count] = 2;
    expect(isFeatureWarm(features)).toBe(false);
  });

  it("returns true when tick_count meets threshold", () => {
    const features = new Array(FEATURE_COUNT).fill(0);
    features[FEATURE_INDEX.tick_count] = 3;
    expect(isFeatureWarm(features)).toBe(true);
  });

  it("returns true when tick_count exceeds threshold", () => {
    const features = new Array(FEATURE_COUNT).fill(0);
    features[FEATURE_INDEX.tick_count] = 50;
    expect(isFeatureWarm(features)).toBe(true);
  });

  it("returns false for empty features array", () => {
    expect(isFeatureWarm([])).toBe(false);
  });

  it("integrates with extractFeatures — cold when no history", () => {
    const features = extractFeatures(makeSyntheticValueBet());
    expect(isFeatureWarm(features)).toBe(false);
  });

  it("integrates with extractFeatures — warm when history has ticks", () => {
    const now = Date.now();
    const sharpKey = makeHistoryKey(
      "evt1",
      "ft_match_result",
      "ft_1x2_home",
      "pinnacle",
    );
    historyStore.set(sharpKey, {
      ticks: [
        { odds: 2.0, timestamp: now - 3000, suspended: false },
        { odds: 2.05, timestamp: now - 2000, suspended: false },
        { odds: 2.03, timestamp: now - 1000, suspended: false },
      ],
      cursor: 3,
      totalTicks: 3,
      openingOdds: 2.0,
      openingTimestamp: now - 3000,
      peakOdds: 2.05,
      troughOdds: 2.0,
    });

    const features = extractFeatures(makeSyntheticValueBet());
    expect(features[FEATURE_INDEX.tick_count]).toBe(3);
    expect(isFeatureWarm(features)).toBe(true);
  });
});

describe("computeConvergenceRate", () => {
  beforeEach(() => {
    historyStore.clear();
  });

  it("returns 0 when no ticks available", () => {
    const rate = computeConvergenceRate(
      "evt1",
      "ft_match_result",
      "ft_1x2_home",
      "pinnacle",
      "ninewickets-exchange",
    );
    expect(rate).toBe(0);
  });

  it("returns 0 when fewer than 3 aligned pairs", () => {
    const now = Date.now();
    const sharpKey = makeHistoryKey(
      "evt1",
      "ft_match_result",
      "ft_1x2_home",
      "pinnacle",
    );
    const softKey = makeHistoryKey(
      "evt1",
      "ft_match_result",
      "ft_1x2_home",
      "ninewickets-exchange",
    );

    historyStore.set(sharpKey, {
      ticks: [
        { odds: 2.0, timestamp: now - 2000, suspended: false },
        { odds: 2.05, timestamp: now - 1000, suspended: false },
      ],
      cursor: 2,
      totalTicks: 2,
      openingOdds: 2.0,
      openingTimestamp: now - 2000,
      peakOdds: 2.05,
      troughOdds: 2.0,
    });

    historyStore.set(softKey, {
      ticks: [
        { odds: 2.3, timestamp: now - 1500, suspended: false },
        { odds: 2.28, timestamp: now - 500, suspended: false },
      ],
      cursor: 2,
      totalTicks: 2,
      openingOdds: 2.3,
      openingTimestamp: now - 1500,
      peakOdds: 2.3,
      troughOdds: 2.28,
    });

    const rate = computeConvergenceRate(
      "evt1",
      "ft_match_result",
      "ft_1x2_home",
      "pinnacle",
      "ninewickets-exchange",
    );
    expect(rate).toBe(0);
  });

  it("returns negative slope for converging series", () => {
    const now = Date.now();
    const sharpKey = makeHistoryKey(
      "evt1",
      "ft_match_result",
      "ft_1x2_home",
      "pinnacle",
    );
    const softKey = makeHistoryKey(
      "evt1",
      "ft_match_result",
      "ft_1x2_home",
      "ninewickets-exchange",
    );

    const sharpTicks = [];
    for (let i = 0; i < 10; i++) {
      sharpTicks.push({
        odds: 2.0,
        timestamp: now - (10 - i) * 1000,
        suspended: false,
      });
    }

    const softTicks = [];
    for (let i = 0; i < 10; i++) {
      softTicks.push({
        odds: 2.4 - i * 0.03,
        timestamp: now - (10 - i) * 1000 + 200,
        suspended: false,
      });
    }

    historyStore.set(sharpKey, {
      ticks: sharpTicks,
      cursor: 10,
      totalTicks: 10,
      openingOdds: 2.0,
      openingTimestamp: now - 10000,
      peakOdds: 2.0,
      troughOdds: 2.0,
    });

    historyStore.set(softKey, {
      ticks: softTicks,
      cursor: 10,
      totalTicks: 10,
      openingOdds: 2.4,
      openingTimestamp: now - 9800,
      peakOdds: 2.4,
      troughOdds: 2.13,
    });

    const rate = computeConvergenceRate(
      "evt1",
      "ft_match_result",
      "ft_1x2_home",
      "pinnacle",
      "ninewickets-exchange",
    );

    expect(rate).toBeLessThan(0);
  });

  it("returns positive slope for diverging series", () => {
    const now = Date.now();
    const sharpKey = makeHistoryKey(
      "evt1",
      "ft_match_result",
      "ft_1x2_home",
      "pinnacle",
    );
    const softKey = makeHistoryKey(
      "evt1",
      "ft_match_result",
      "ft_1x2_home",
      "ninewickets-exchange",
    );

    const sharpTicks = [];
    for (let i = 0; i < 10; i++) {
      sharpTicks.push({
        odds: 2.0,
        timestamp: now - (10 - i) * 1000,
        suspended: false,
      });
    }

    const softTicks = [];
    for (let i = 0; i < 10; i++) {
      softTicks.push({
        odds: 2.1 + i * 0.03,
        timestamp: now - (10 - i) * 1000 + 200,
        suspended: false,
      });
    }

    historyStore.set(sharpKey, {
      ticks: sharpTicks,
      cursor: 10,
      totalTicks: 10,
      openingOdds: 2.0,
      openingTimestamp: now - 10000,
      peakOdds: 2.0,
      troughOdds: 2.0,
    });

    historyStore.set(softKey, {
      ticks: softTicks,
      cursor: 10,
      totalTicks: 10,
      openingOdds: 2.1,
      openingTimestamp: now - 9800,
      peakOdds: 2.37,
      troughOdds: 2.1,
    });

    const rate = computeConvergenceRate(
      "evt1",
      "ft_match_result",
      "ft_1x2_home",
      "pinnacle",
      "ninewickets-exchange",
    );

    expect(rate).toBeGreaterThan(0);
  });
});
