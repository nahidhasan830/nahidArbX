import type { BetRow } from "@/lib/db/schema";

export function isDashboardDemoRequest(req: Request): boolean {
  return new URL(req.url).searchParams.get("demo") === "1";
}

type DemoOutcome =
  | "won"
  | "lost"
  | "half_won"
  | "half_lost"
  | "void"
  | "pending";

type DemoMarket = {
  familyId: string;
  atomId: string;
  atomLabel: string;
  marketType: string;
  timeScope: string;
  familyLine: number | null;
};

type DemoFixture = {
  homeTeam: string;
  awayTeam: string;
  competition: string;
};

type DemoBetInput = {
  fixture: DemoFixture;
  market: DemoMarket;
  provider: "ninewickets-sportsbook" | "velki-sportsbook";
  stake: number;
  odds: number;
  outcome: DemoOutcome;
  clvPct: number;
  evPct: number;
  placedHoursAgo: number;
  mode: "auto" | "manual";
};

export function buildDemoDashboardAccounts(now = new Date()) {
  return [
    {
      provider: "ninewickets-sportsbook",
      providerDisplayName: "9W Sportsbook",
      username: "nahid_9w",
      currency: "BDT",
      balance: 8400,
      exposure: 800,
      minBet: 100,
      suspended: false,
      lastSyncedAt: shiftIso(now, -0.01),
      error: null,
      isDemo: false,
      autoPlaceEnabled: true,
      session: {
        health: "healthy" as const,
        capturedAt: shiftIso(now, -2.4),
      },
    },
    {
      provider: "velki-sportsbook",
      providerDisplayName: "Velki Sportsbook",
      username: "nahid_velki",
      currency: "BDT",
      balance: 5700,
      exposure: 500,
      minBet: 100,
      suspended: false,
      lastSyncedAt: shiftIso(now, -0.02),
      error: null,
      isDemo: false,
      autoPlaceEnabled: false,
      session: {
        health: "healthy" as const,
        capturedAt: shiftIso(now, -1.7),
      },
    },
  ];
}

export function buildDemoNineWicketsOverview(now = new Date()) {
  return {
    ok: true,
    at: now.toISOString(),
    providerInfo: {
      betCredit: 8400,
      exposure: 800,
      suspended: false,
      minBet: 100,
    },
    mainSite: {
      withdrawable: 7600,
      cashWallet: 800,
      userName: "nahid_9w",
      vip: {
        nowVipName: "Gold",
        nowVipPercent: 67,
        nextVipName: "Platinum",
      },
      providerStatuses: [
        {
          providerId: 101,
          providerName: "Sportsbook",
          vendorCode: "9W-SB",
          status: 1 as const,
          exposure: "800.00",
        },
        {
          providerId: 102,
          providerName: "Exchange",
          vendorCode: "9W-EX",
          status: 1 as const,
          exposure: "0.00",
        },
      ],
    },
    turnover: {
      canWithdraw: true,
      recordsCount: 6,
      records: [],
    },
    unmatchedTickets: [
      demoTicket(940211, "Manchester City vs Tottenham Hotspur", "Over 2.5", "Over", 1.86, now),
      demoTicket(940218, "Inter Milan vs Lazio", "Asian Handicap", "Inter Milan -0.5", 1.92, now),
    ],
    autoLogin: {
      enabled: true,
      reason: null,
      updatedAt: shiftIso(now, -18),
    },
    reconciled: {
      pendingBefore: 8,
      pendingAfter: 6,
      ticketsAttached: 2,
      at: shiftIso(now, -0.03),
    },
    errors: {},
  };
}

export function buildDemoVelkiOverview(now = new Date()) {
  return {
    ok: true,
    at: now.toISOString(),
    providerInfo: {
      betCredit: 5700,
      exposure: 500,
      suspended: false,
      minBet: 100,
    },
    mainSite: null,
    turnover: null,
    autoLogin: {
      enabled: true,
      reason: null,
      updatedAt: shiftIso(now, -11),
    },
    recaptured: false,
    errors: {},
  };
}

export function buildDemoDashboardRows(now = new Date()): BetRow[] {
  return DEMO_BETS.map((input, index) => toBetRow(input, index, now));
}

const fixtures: DemoFixture[] = [
  {
    homeTeam: "Manchester City",
    awayTeam: "Tottenham Hotspur",
    competition: "English Premier League",
  },
  {
    homeTeam: "Arsenal",
    awayTeam: "Aston Villa",
    competition: "English Premier League",
  },
  {
    homeTeam: "Barcelona",
    awayTeam: "Villarreal",
    competition: "La Liga",
  },
  {
    homeTeam: "Inter Milan",
    awayTeam: "Lazio",
    competition: "Serie A",
  },
  {
    homeTeam: "Bayern Munich",
    awayTeam: "RB Leipzig",
    competition: "Bundesliga",
  },
  {
    homeTeam: "PSG",
    awayTeam: "Lyon",
    competition: "Ligue 1",
  },
  {
    homeTeam: "Abahani Limited Dhaka",
    awayTeam: "Bashundhara Kings",
    competition: "Bangladesh Premier League",
  },
  {
    homeTeam: "Al Hilal",
    awayTeam: "Al Nassr",
    competition: "Saudi Pro League",
  },
  {
    homeTeam: "Japan U23",
    awayTeam: "South Korea U23",
    competition: "AFC U23 Asian Cup",
  },
  {
    homeTeam: "Flamengo",
    awayTeam: "Palmeiras",
    competition: "Brazil Serie A",
  },
];

const markets: DemoMarket[] = [
  {
    familyId: "football_full_time_1x2",
    atomId: "home",
    atomLabel: "Home Win",
    marketType: "1X2",
    timeScope: "full_time",
    familyLine: null,
  },
  {
    familyId: "football_full_time_1x2",
    atomId: "away",
    atomLabel: "Away Win",
    marketType: "1X2",
    timeScope: "full_time",
    familyLine: null,
  },
  {
    familyId: "football_total_goals_2_5",
    atomId: "over_2_5",
    atomLabel: "Over 2.5",
    marketType: "Total Goals",
    timeScope: "full_time",
    familyLine: 2.5,
  },
  {
    familyId: "football_total_goals_2_5",
    atomId: "under_2_5",
    atomLabel: "Under 2.5",
    marketType: "Total Goals",
    timeScope: "full_time",
    familyLine: 2.5,
  },
  {
    familyId: "football_asian_handicap_home_minus_0_5",
    atomId: "home_minus_0_5",
    atomLabel: "Home -0.5",
    marketType: "Asian Handicap",
    timeScope: "full_time",
    familyLine: -0.5,
  },
  {
    familyId: "football_btts",
    atomId: "yes",
    atomLabel: "Yes",
    marketType: "Both Teams To Score",
    timeScope: "full_time",
    familyLine: null,
  },
  {
    familyId: "football_corners_total_9_5",
    atomId: "over_9_5",
    atomLabel: "Over 9.5 Corners",
    marketType: "Corners Total",
    timeScope: "full_time",
    familyLine: 9.5,
  },
];

const outcomes: DemoOutcome[] = [
  "won",
  "lost",
  "won",
  "won",
  "half_won",
  "lost",
  "won",
  "void",
  "won",
  "lost",
  "won",
  "void",
  "lost",
  "won",
  "half_lost",
  "won",
  "lost",
  "won",
  "void",
  "lost",
  "half_won",
  "won",
  "won",
  "lost",
  "won",
  "won",
  "lost",
  "void",
  "won",
  "half_lost",
  "won",
  "lost",
  "won",
  "won",
  "lost",
  "won",
  "pending",
  "pending",
  "pending",
  "pending",
  "pending",
  "pending",
];

const stakePattern = [
  100, 100, 100, 100, 100, 200, 100, 200, 100, 100, 100, 200, 100, 100,
  200, 100, 100, 100, 200, 100, 100, 100, 100, 100, 100, 100, 100, 200,
  100, 100, 100, 100, 100, 100, 100, 100, 0, 0, 0, 0, 0, 0,
];

const oddsPattern = [
  1.82, 2.18, 1.94, 2.34, 1.72, 2.08, 1.88, 3.1, 2.46, 1.68, 2.2, 1.76,
  2.62, 1.91, 2.28, 1.7, 2.04, 2.38, 1.83, 2.72, 1.66, 2.14, 1.96, 2.5,
  1.79, 2.06, 2.32, 3.35, 1.87, 2.58, 1.74, 2.22, 1.92, 2.44, 1.69, 2.16,
  1.85, 2.08, 1.91, 2.36, 1.78, 2.52,
];

const clvPattern = [
  3.4, -1.2, 2.1, 4.8, 1.6, -2.4, 2.9, 0.2, 5.1, -0.8, 3.7, 2.5, -1.7,
  4.2, -0.9, 1.8, -2.1, 3.1, 2.8, -1.4, 1.1, 4.9, 3.5, -2.6, 2.2, 3.8,
  -0.5, 0.4, 2.7, -1.1, 4.4, -2.2, 1.9, 3.2, -0.7, 2.6, 3.6, 1.4, 2.8,
  4.1, 1.7, 3.3,
];

const evPattern = [
  6, 3, 5, 7, 4, 3, 5, 2, 8, 3, 7, 4, 3, 6, 4, 5, 3, 6, 5, 3, 3, 7, 6,
  4, 4, 6, 3, 4, 5, 3, 8, 3, 5, 7, 3, 6, 7, 4, 5, 7, 4, 8,
];

const DEMO_BETS: DemoBetInput[] = outcomes.map((outcome, index) => ({
  fixture: fixtures[index % fixtures.length],
  market: markets[index % markets.length],
  provider: index % 3 === 1 ? "velki-sportsbook" : "ninewickets-sportsbook",
  stake: stakePattern[index],
  odds: oddsPattern[index],
  outcome,
  clvPct: clvPattern[index],
  evPct: evPattern[index],
  placedHoursAgo:
    outcome === "pending"
      ? 12 - (index - 36) * 1.4
      : 32 * 24 - index * 18 - (index % 4) * 2,
  mode: index % 4 === 0 ? "manual" : "auto",
}));

function toBetRow(input: DemoBetInput, index: number, now: Date): BetRow {
  const placedAt = shiftIso(now, -input.placedHoursAgo);
  const eventStartTime =
    input.outcome === "pending"
      ? shiftIso(now, 7 + (index - 36) * 4)
      : shiftIso(new Date(placedAt), 2.2);
  const settledAt =
    input.outcome === "pending" ? null : shiftIso(new Date(placedAt), 4.6);
  const adjustedOdds = input.odds;
  const sharpTrueProb = round5((1 + input.evPct / 100) / adjustedOdds);
  const pnl = computePnl(input.outcome, input.stake, input.odds);
  const providerPrefix =
    input.provider === "ninewickets-sportsbook" ? "9W" : "VEL";

  return {
    id: `demo-${index + 1}`,
    eventId: `demo-event-${index + 1}`,
    familyId: input.market.familyId,
    atomId: input.market.atomId,
    atomLabel: input.market.atomLabel,
    homeTeam: input.fixture.homeTeam,
    awayTeam: input.fixture.awayTeam,
    competition: input.fixture.competition,
    eventStartTime,
    marketType: input.market.marketType,
    timeScope: input.market.timeScope,
    familyLine: input.market.familyLine,
    sharpProvider: "pinnacle",
    sharpOdds: round4(1 / sharpTrueProb),
    sharpTrueProb,
    softProvider: input.provider,
    softCommissionPct: 0,
    softOdds: input.odds,
    closingSharpOdds: round4(input.odds * (1 - input.clvPct / 100)),
    firstSeenAt: shiftIso(new Date(placedAt), -0.22),
    lastSeenAt: shiftIso(new Date(placedAt), -0.04),
    tickCount: 3 + (index % 9),
    placedAt,
    provider: input.provider,
    stake: input.stake,
    odds: input.odds,
    currency: "BDT",
    providerTicketId:
      input.outcome === "pending"
        ? null
        : `${providerPrefix}-${String(240000 + index).padStart(6, "0")}`,
    mode: input.mode,
    outcome: input.outcome,
    settledBySource: input.outcome === "pending" ? null : "demo-source",
    settledAt,
    pnl,
    clvPct: input.clvPct,
    settleAttempts: input.outcome === "pending" ? 0 : 1,
    lastSettleAttemptAt: settledAt,
    oddsMovement: null,
    mlFeatures: null,
    mlScore: null,
    mlStakeFraction: null,
    mlFeatureVersion: null,
    mlFeatureCount: null,
    mlFeatureNamesHash: null,
    placedMlScore: null,
    placedMlModelEdgePct: null,
    placedMlDecision: null,
    placedMlKellyMultiplier: null,
    placedMlModelVersion: null,
    placedMlFeatures: null,
    placedMlFeatureVersion: null,
    placedMlFeatureCount: null,
    placedMlFeatureNamesHash: null,
  };
}

function demoTicket(
  id: number,
  eventName: string,
  marketName: string,
  selectionName: string,
  odds: number,
  now: Date,
) {
  return {
    id,
    eventName,
    marketName,
    selectionName,
    odds,
    initPrice: odds,
    lastPrice: odds,
    status: 1,
    createDate: Date.parse(shiftIso(now, -1.5)),
    createDateStr: shiftIso(now, -1.5),
  };
}

function computePnl(
  outcome: DemoOutcome,
  stake: number,
  odds: number,
): number | null {
  if (outcome === "pending") return null;
  if (outcome === "won") return round2(stake * (odds - 1));
  if (outcome === "half_won") return round2((stake * (odds - 1)) / 2);
  if (outcome === "lost") return -stake;
  if (outcome === "half_lost") return round2(-stake / 2);
  return 0;
}

function shiftIso(date: Date, hours: number): string {
  return new Date(date.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function round5(value: number): number {
  return Math.round(value * 100000) / 100000;
}
