export type Outcome =
  | "pending"
  | "won"
  | "half_won"
  | "lost"
  | "half_lost"
  | "void";

/** The six ordered outcome values, handy for iteration in UI & schemas. */
export const OUTCOMES: readonly Outcome[] = [
  "pending",
  "won",
  "half_won",
  "lost",
  "half_lost",
  "void",
] as const;

/** Fraction of the stake at risk in the win/lose branch for a given outcome.
 *  Half-wins / half-losses push the other half of the stake. */
export const stakeFractionForOutcome = (o: Outcome): number => {
  if (o === "won" || o === "lost") return 1;
  if (o === "half_won" || o === "half_lost") return 0.5;
  return 0;
};

/**
 * Legacy rows in the DB may still contain the historical "push" outcome.
 * For our atom-based settlement it's indistinguishable from "void" — stake
 * is returned, no P&L. Collapse push → void everywhere on read. Unknown
 * values fall back to "pending".
 */
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

/** True for settled (non-pending) outcomes. */
export const isSettledOutcome = (o: Outcome): boolean => o !== "pending";

/** True for outcomes that contribute to win/loss P&L (i.e. not void). */
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

export type AiLabelSource = {
  url: string;
  title: string;
};

export type AiLabelProposal = {
  id: string;
  proposedOutcome: Outcome;
  confidence: number;
  sources: AiLabelSource[];
  reasoning: string;
};

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

  closingSharpOdds: number | null;


  outcome: Outcome | string;
  /** Pipeline tier/source that produced the outcome — null while pending. */
  settledBySource: string | null;
  /** When the outcome was resolved — null while pending. */
  settledAt: string | null;
  /** Count of settlement-pipeline ticks that touched this row. */
  settleAttempts: number;
  lastSettleAttemptAt: string | null;

  /** Odds movement snapshot from detection time (persisted JSONB).
   *  Typed shape when parsed, `unknown` when fresh from Drizzle. */
  oddsMovement?: OddsMovementData | unknown | null;
};

/** Parsed shape of the odds_movement JSONB blob. */
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
