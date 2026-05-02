/**
 * Unit tests for ML feature extraction and convergence calculator.
 *
 * Uses Vitest (`npx vitest run`).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---- In-memory test data ----

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
  { id: string; startTime: Date; homeTeam: string; awayTeam: string }
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

// ---- Mocks ----

vi.mock("@/lib/atoms/odds-history", () => ({
  getAtomHistory: (
    eventId: string,
    familyId: string,
    atomId: string,
    provider: string,
  ) => historyStore.get(makeHistoryKey(eventId, familyId, atomId, provider)) ?? null,
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
    return hist.ticks.filter((t: { odds: number; timestamp: number; suspended: boolean }) => t != null);
  },
  detectSteamMove: () => null,
  getMovementSummary: () => null,
  recordOddsTick: () => {},
}));

vi.mock("@/lib/atoms/store", () => ({
  getAllOddsForAtom: (
    eventId: string,
    familyId: string,
    atomId: string,
  ) => oddsAtomStore.get(makeAtomKey(eventId, familyId, atomId)) ?? new Map(),
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

// ---- Import after mocking ----

import { extractFeatures, FEATURE_NAMES, FEATURE_COUNT } from "@/lib/ml/features";
import { computeConvergenceRate } from "@/lib/ml/convergence";

// ============================================
// Test helpers
// ============================================

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
    timestamp: now - 500, // 500ms old
    ...overrides,
  } as Parameters<typeof extractFeatures>[0];
}

// ============================================
// Tests
// ============================================

describe("FEATURE_NAMES", () => {
  it("has exactly 23 entries", () => {
    expect(FEATURE_NAMES).toHaveLength(23);
    expect(FEATURE_COUNT).toBe(23);
  });

  it("has unique entries", () => {
    const unique = new Set(FEATURE_NAMES);
    expect(unique.size).toBe(23);
  });

  it("starts with ev_pct and ends with vig_pct", () => {
    expect(FEATURE_NAMES[0]).toBe("ev_pct");
    expect(FEATURE_NAMES[22]).toBe("vig_pct");
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

  it("returns a 23-element number array", () => {
    const vb = makeSyntheticValueBet();
    const features = extractFeatures(vb);

    expect(features).toHaveLength(23);
    for (let i = 0; i < 23; i++) {
      expect(typeof features[i]).toBe("number");
      expect(Number.isNaN(features[i])).toBe(false);
    }
  });

  it("correctly extracts basic ValueBet fields", () => {
    const vb = makeSyntheticValueBet();
    const features = extractFeatures(vb);

    expect(features[0]).toBe(2.6);           // ev_pct
    expect(features[1]).toBe(0.48);          // sharp_true_prob
    expect(features[2]).toBe(2.25);          // soft_odds
    expect(features[3]).toBe(2.1375);        // adjusted_soft_odds
    expect(features[20]).toBe(5);            // commission_pct (ninewickets-exchange = 5%)
  });

  it("rounds all values to 4 decimal places", () => {
    const vb = makeSyntheticValueBet({
      evPct: 2.123456789,
      trueProb: 0.4812345,
    });
    const features = extractFeatures(vb);

    expect(features[0]).toBe(2.1235); // evPct
    expect(features[1]).toBe(0.4812); // trueProb
  });

  it("uses event startTime for time_to_kickoff_min", () => {
    const futureKickoff = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
    eventStore.set("evt1", {
      id: "evt1",
      startTime: futureKickoff,
      homeTeam: "Team A",
      awayTeam: "Team B",
    });

    const vb = makeSyntheticValueBet();
    const features = extractFeatures(vb);

    // time_to_kickoff_min (idx 7) should be approximately 60
    expect(features[7]).toBeGreaterThanOrEqual(59);
    expect(features[7]).toBeLessThanOrEqual(61);
  });

  it("encodes market type as ordinal", () => {
    familyStore.set("ft_match_result", {
      id: "ft_match_result",
      type: "group",
      time_scope: "FT",
      market_type: "MATCH_RESULT",
      atoms: ["ft_1x2_home", "ft_1x2_draw", "ft_1x2_away"],
    });

    const vb = makeSyntheticValueBet();
    const features = extractFeatures(vb);

    expect(features[18]).toBe(0); // MATCH_RESULT = 0
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

    const vb = makeSyntheticValueBet();
    const features = extractFeatures(vb);

    expect(features[19]).toBe(1); // 0.25 is quarter ball = asian
  });

  it("reads vig from cached vig data", () => {
    vigCache.set("evt1|ft_match_result", {
      vigPct: 4.5,
      familyId: "ft_match_result",
      provider: "pinnacle",
    });

    const vb = makeSyntheticValueBet();
    const features = extractFeatures(vb);

    expect(features[22]).toBe(4.5); // vig_pct
  });

  it("defaults missing data to 0", () => {
    const vb = makeSyntheticValueBet();
    const features = extractFeatures(vb);

    expect(features[6]).toBe(0);   // tick_count
    expect(features[7]).toBe(0);   // time_to_kickoff_min
    expect(features[14]).toBe(0);  // convergence_rate
    expect(features[17]).toBe(0);  // opening_sharp_odds
    expect(features[22]).toBe(0);  // vig_pct
  });

  it("computes provider_count from odds store", () => {
    const atomKey = makeAtomKey("evt1", "ft_match_result", "ft_1x2_home");
    const providers = new Map();
    providers.set("pinnacle", { odds: 2.1, timestamp: Date.now() });
    providers.set("ninewickets-exchange", { odds: 2.25, timestamp: Date.now() });
    providers.set("velki-sportsbook", { odds: 2.2, timestamp: Date.now() });
    oddsAtomStore.set(atomKey, providers);

    const vb = makeSyntheticValueBet();
    const features = extractFeatures(vb);

    expect(features[16]).toBe(3); // provider_count
  });
});

describe("computeConvergenceRate", () => {
  beforeEach(() => {
    historyStore.clear();
  });

  it("returns 0 when no ticks available", () => {
    const rate = computeConvergenceRate(
      "evt1", "ft_match_result", "ft_1x2_home",
      "pinnacle", "ninewickets-exchange",
    );
    expect(rate).toBe(0);
  });

  it("returns 0 when fewer than 3 aligned pairs", () => {
    const now = Date.now();
    const sharpKey = makeHistoryKey("evt1", "ft_match_result", "ft_1x2_home", "pinnacle");
    const softKey = makeHistoryKey("evt1", "ft_match_result", "ft_1x2_home", "ninewickets-exchange");

    historyStore.set(sharpKey, {
      ticks: [
        { odds: 2.0, timestamp: now - 2000, suspended: false },
        { odds: 2.05, timestamp: now - 1000, suspended: false },
      ],
      cursor: 2, totalTicks: 2, openingOdds: 2.0,
      openingTimestamp: now - 2000, peakOdds: 2.05, troughOdds: 2.0,
    });

    historyStore.set(softKey, {
      ticks: [
        { odds: 2.3, timestamp: now - 1500, suspended: false },
        { odds: 2.28, timestamp: now - 500, suspended: false },
      ],
      cursor: 2, totalTicks: 2, openingOdds: 2.3,
      openingTimestamp: now - 1500, peakOdds: 2.3, troughOdds: 2.28,
    });

    const rate = computeConvergenceRate(
      "evt1", "ft_match_result", "ft_1x2_home",
      "pinnacle", "ninewickets-exchange",
    );
    expect(rate).toBe(0);
  });

  it("returns negative slope for converging series", () => {
    const now = Date.now();
    const sharpKey = makeHistoryKey("evt1", "ft_match_result", "ft_1x2_home", "pinnacle");
    const softKey = makeHistoryKey("evt1", "ft_match_result", "ft_1x2_home", "ninewickets-exchange");

    // Sharp odds stable at 2.0
    const sharpTicks = [];
    for (let i = 0; i < 10; i++) {
      sharpTicks.push({ odds: 2.0, timestamp: now - (10 - i) * 1000, suspended: false });
    }

    // Soft odds converging toward sharp (decreasing from 2.4 to 2.13)
    const softTicks = [];
    for (let i = 0; i < 10; i++) {
      softTicks.push({
        odds: 2.4 - i * 0.03,
        timestamp: now - (10 - i) * 1000 + 200,
        suspended: false,
      });
    }

    historyStore.set(sharpKey, {
      ticks: sharpTicks, cursor: 10, totalTicks: 10,
      openingOdds: 2.0, openingTimestamp: now - 10000, peakOdds: 2.0, troughOdds: 2.0,
    });

    historyStore.set(softKey, {
      ticks: softTicks, cursor: 10, totalTicks: 10,
      openingOdds: 2.4, openingTimestamp: now - 9800, peakOdds: 2.4, troughOdds: 2.13,
    });

    const rate = computeConvergenceRate(
      "evt1", "ft_match_result", "ft_1x2_home",
      "pinnacle", "ninewickets-exchange",
    );

    expect(rate).toBeLessThan(0); // gap decreasing → negative slope
  });

  it("returns positive slope for diverging series", () => {
    const now = Date.now();
    const sharpKey = makeHistoryKey("evt1", "ft_match_result", "ft_1x2_home", "pinnacle");
    const softKey = makeHistoryKey("evt1", "ft_match_result", "ft_1x2_home", "ninewickets-exchange");

    const sharpTicks = [];
    for (let i = 0; i < 10; i++) {
      sharpTicks.push({ odds: 2.0, timestamp: now - (10 - i) * 1000, suspended: false });
    }

    // Soft odds diverging (increasing from 2.1 to 2.37)
    const softTicks = [];
    for (let i = 0; i < 10; i++) {
      softTicks.push({
        odds: 2.1 + i * 0.03,
        timestamp: now - (10 - i) * 1000 + 200,
        suspended: false,
      });
    }

    historyStore.set(sharpKey, {
      ticks: sharpTicks, cursor: 10, totalTicks: 10,
      openingOdds: 2.0, openingTimestamp: now - 10000, peakOdds: 2.0, troughOdds: 2.0,
    });

    historyStore.set(softKey, {
      ticks: softTicks, cursor: 10, totalTicks: 10,
      openingOdds: 2.1, openingTimestamp: now - 9800, peakOdds: 2.37, troughOdds: 2.1,
    });

    const rate = computeConvergenceRate(
      "evt1", "ft_match_result", "ft_1x2_home",
      "pinnacle", "ninewickets-exchange",
    );

    expect(rate).toBeGreaterThan(0); // gap increasing → positive slope
  });
});
