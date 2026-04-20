/**
 * Shared staking-strategy catalog + BDT sizing function.
 *
 * The strategy list is a re-export of the backtest `STRATEGIES` array so
 * the dashboard selector, the backtest analyzer, and the auto-placer
 * can never drift. If we add a strategy there (e.g. a smoothed Kelly
 * variant) it lights up everywhere automatically.
 *
 * The backtest's `stakeFor` returns stakes in *abstract units* that are
 * meaningful for comparison (ROI %, drawdown). For live auto-placement
 * we need BDT, so `computeStakeBdt` below scales those units against
 * the operator's bankroll + unit size. Kelly variants scale with the
 * live Kelly fraction (fullKelly × multiplier × bankroll); `flat` and
 * `ev-prop` return unit-denominated stakes that multiply by `unitSize`.
 */
import { STRATEGIES as BACKTEST_STRATEGIES } from "@/lib/backtest/analyze";
import type { StrategyId } from "@/lib/backtest/types";

export type { StrategyId } from "@/lib/backtest/types";

export interface StrategyDescriptor {
  id: StrategyId;
  label: string;
  /** Short explanation for the dashboard tooltip. */
  description: string;
}

const DESCRIPTIONS: Record<StrategyId, string> = {
  flat: "Stake a fixed number of units every bet. Simplest. Ignores edge and odds.",
  kelly:
    "Full Kelly: maximises long-run growth but is volatile. Use only with very high confidence in your true-probability model.",
  "frac-kelly-0.5":
    "Half Kelly: softer, lower drawdown than Full Kelly. Popular middle ground.",
  "frac-kelly-0.25":
    "Quarter Kelly: conservative default. Good tolerance to model error.",
  "ev-prop": "Stake scales with EV%. Flat at max(0, EV%) × 4 units.",
};

export const STRATEGIES: StrategyDescriptor[] = BACKTEST_STRATEGIES.map(
  (s) => ({
    id: s.id,
    label: s.label,
    description: DESCRIPTIONS[s.id],
  }),
);

export const DEFAULT_STRATEGY: StrategyId = "frac-kelly-0.25";

export function isStrategyId(x: unknown): x is StrategyId {
  return (
    typeof x === "string" && STRATEGIES.some((s) => s.id === (x as StrategyId))
  );
}

export interface StakeInputs {
  strategyId: StrategyId;
  /** Full Kelly fraction (b*p - q)/b, in [0, 1]. Clamp to >= 0 before use. */
  fullKellyFraction: number;
  /** EV percentage. Positive = edge. */
  evPct: number;
  /** Bankroll in BDT for Kelly variants. */
  bankrollBdt: number;
  /** Unit size in BDT for flat/ev-prop. */
  unitSizeBdt: number;
  /** Per-bet cap as a percentage of bankroll. Default 10%. */
  kellyCapPct: number;
}

/**
 * Derive fullKelly fraction and EV% from the raw value-bet row fields.
 * Single source of truth; called by both the backend placer (sizing
 * at placement time) and the dashboard settings preview. Kept in sync
 * with the formula in ValueBetDetailsModal.
 */
export function deriveEdgeForRow(row: {
  softOddsLast: number;
  softCommissionPct: number;
  sharpTrueProb: number;
}): { evPct: number; fullKelly: number; adjustedOdds: number } {
  const adjustedOdds =
    1 + (row.softOddsLast - 1) * (1 - row.softCommissionPct / 100);
  const p = row.sharpTrueProb;
  const b = adjustedOdds - 1;
  const evPct = (adjustedOdds * p - 1) * 100;
  const fullKelly = b > 0 ? (b * p - (1 - p)) / b : 0;
  return { evPct, fullKelly, adjustedOdds };
}

/**
 * Convert a strategy choice into a BDT stake. Pre-rounding, pre-clamp
 * to book min/max — those happen in the placer. This function only
 * encodes the strategy-to-stake math.
 */
export function computeStakeBdt(inputs: StakeInputs): number {
  const kelly = Math.max(0, inputs.fullKellyFraction);
  const cap = Math.max(0, inputs.bankrollBdt * (inputs.kellyCapPct / 100));

  switch (inputs.strategyId) {
    case "flat":
      return inputs.unitSizeBdt;
    case "kelly":
      return Math.min(kelly * inputs.bankrollBdt, cap);
    case "frac-kelly-0.5":
      return Math.min(kelly * 0.5 * inputs.bankrollBdt, cap);
    case "frac-kelly-0.25":
      return Math.min(kelly * 0.25 * inputs.bankrollBdt, cap);
    case "ev-prop":
      return Math.max(0, inputs.evPct / 100) * 4 * inputs.unitSizeBdt;
  }
}
