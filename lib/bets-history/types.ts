export type Outcome =
  | "pending"
  | "won"
  | "half_won"
  | "lost"
  | "half_lost"
  | "void";

export const OUTCOMES: readonly Outcome[] = [
  "pending",
  "won",
  "half_won",
  "lost",
  "half_lost",
  "void",
] as const;

export const stakeFractionForOutcome = (o: Outcome): number => {
  if (o === "won" || o === "lost") return 1;
  if (o === "half_won" || o === "half_lost") return 0.5;
  return 0;
};

export const normalizeOutcome = (o: string | null | undefined): Outcome => {
  if (o === "push") return "void";
  if (
    o === "won" ||
    o === "half_won" ||
    o === "lost" ||
    o === "half_lost" ||
    o === "void" ||
    o === "pending"
  )
    return o;
  return "pending";
};

export const isSettledOutcome = (o: Outcome): boolean => o !== "pending";

export const hasPnl = (o: Outcome): boolean =>
  o === "won" || o === "half_won" || o === "lost" || o === "half_lost";

export type SoftProvider =
  | "ninewickets-exchange"
  | "ninewickets-sportsbook"
  | "betconstruct";

export type MarketType =
  | "MATCH_RESULT"
  | "OVER_UNDER"
  | "BTTS"
  | "ASIAN_HANDICAP";

export type TimeScope = "FT" | "1H" | "2H";

export type ValueBetRow = {
  id: string;
  eventId: string;
  familyId: string;
  atomId: string;
  atomLabel: string;

  homeTeam: string;
  awayTeam: string;
  competition: string | null;
  eventStartTime: string;

  marketType: MarketType | string;
  timeScope: TimeScope | string;
  familyLine: number | null;

  sharpProvider: "pinnacle" | string;
  sharpOdds: number;
  sharpTrueProb: number;

  softProvider: SoftProvider | string;
  softCommissionPct: number;
  softOdds: number;

  firstSeenAt: string;
  lastSeenAt: string;
  tickCount: number;

  placedAt?: string | null;
  provider?: string | null;
  stake?: number | null;
  odds?: number | null;
  currency?: string | null;
  providerTicketId?: string | null;
  mode?: string | null;

  closingSharpOdds: number | null;

  outcome: Outcome | string;
  settledBySource: string | null;
  settledAt: string | null;
  pnl?: number | null;
  clvPct?: number | null;
  settleAttempts: number;
  lastSettleAttemptAt: string | null;

  oddsMovement?: Record<string, OddsMovementData> | OddsMovementData | null;

  mlFeatures?: number[] | null;
  mlFeatureVersion?: number | null;
  mlFeatureCount?: number | null;
  mlFeatureNamesHash?: string | null;
  mlScore?: number | null;
  mlStakeFraction?: number | null;

  placedMlScore?: number | null;
  placedMlModelEdgePct?: number | null;
  placedMlDecision?: string | null;
  placedMlKellyMultiplier?: number | null;
  placedMlModelVersion?: number | null;

  matchScore?: BetMatchScore | null;
};

export type BetMatchScore = {
  status: string;
  htHome: number | null;
  htAway: number | null;
  ftHome: number;
  ftAway: number;
  etHome: number | null;
  etAway: number | null;
  penHome: number | null;
  penAway: number | null;
  cornersHome: number | null;
  cornersAway: number | null;
  bookingsHome: number | null;
  bookingsAway: number | null;
  source: string;
  confidence: number;
};

export type OddsMovementData = {
  provider: string;
  openingOdds: number | null;
  peakOdds: number;
  troughOdds: number;
  totalTicks: number;
  sparkline: [number, number][];
};

export type BetFilters = {
  from?: string;
  to?: string;
  marketType?: MarketType | "all";
  timeScope?: TimeScope | "all";
  softProvider?: SoftProvider | "all";
  minEv?: number;
  maxEv?: number;
  outcome?: Outcome | "all" | "settled" | "unsettled";
  search?: string;
};
