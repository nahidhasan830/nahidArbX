import type { ValueBetRow } from "./types";

export type DerivedMetrics = {
  softOddsAdjustedFirst: number;
  softOddsAdjustedLast: number;
  softOddsAdjustedMax: number;
  sharpTrueOdds: number;
  evPctFirst: number;
  evPctLast: number;
  evPctMax: number;
  kellyFractionFirst: number;
};

const commissionFactor = (pct: number) => 1 - pct / 100;

const kellyFraction = (adjustedOdds: number, trueProb: number): number => {
  const b = adjustedOdds - 1;
  if (b <= 0) return 0;
  const q = 1 - trueProb;
  return Math.max(0, (b * trueProb - q) / b);
};

export const derive = (row: ValueBetRow): DerivedMetrics => {
  const cf = commissionFactor(row.softCommissionPct);
  const softOddsAdjustedFirst = 1 + (row.softOddsFirst - 1) * cf;
  const softOddsAdjustedLast = 1 + (row.softOddsLast - 1) * cf;
  const softOddsAdjustedMax = 1 + (row.softOddsMax - 1) * cf;
  const sharpTrueOdds = 1 / row.sharpTrueProb;
  const evPctFirst = (softOddsAdjustedFirst * row.sharpTrueProb - 1) * 100;
  const evPctLast = (softOddsAdjustedLast * row.sharpTrueProb - 1) * 100;
  const evPctMax = (softOddsAdjustedMax * row.sharpTrueProb - 1) * 100;
  const kellyFractionFirst = kellyFraction(
    softOddsAdjustedFirst,
    row.sharpTrueProb,
  );
  return {
    softOddsAdjustedFirst,
    softOddsAdjustedLast,
    softOddsAdjustedMax,
    sharpTrueOdds,
    evPctFirst,
    evPctLast,
    evPctMax,
    kellyFractionFirst,
  };
};

export const kellyStake = (
  row: ValueBetRow,
  bankroll: number,
  kellyMultiplier = 1,
): number => {
  const { kellyFractionFirst } = derive(row);
  return kellyFractionFirst * kellyMultiplier * bankroll;
};

export type SettlementStrategy =
  | { kind: "flat"; unit: number }
  | { kind: "kelly"; bankroll: number; multiplier: number }
  | { kind: "ev-prop"; bankroll: number; cap: number };

export const stakeForStrategy = (
  row: ValueBetRow,
  strategy: SettlementStrategy,
): number => {
  switch (strategy.kind) {
    case "flat":
      return strategy.unit;
    case "kelly":
      return kellyStake(row, strategy.bankroll, strategy.multiplier);
    case "ev-prop": {
      const { evPctFirst } = derive(row);
      return Math.min(
        strategy.cap,
        Math.max(0, evPctFirst / 100) * strategy.bankroll,
      );
    }
  }
};

/**
 * P&L for a settled row given a stake.
 *
 * Wins are booked at softOddsFirst — the price at first detection, which is
 * the realistic entry price. softOddsLast is the closing/current price and
 * only has analytical value for CLV, not for P&L.
 *
 * For Asian-Handicap / Over-Under quarter lines the outcome is split:
 * - "half_won"  → half the stake wins at the quoted odds, the other half
 *                 pushes (stake returned). Net = 0.5 × stake × (odds − 1).
 * - "half_lost" → half the stake loses, the other half pushes.
 *                 Net = −0.5 × stake.
 * "void" (and the legacy "push") leaves P&L at 0 — stake returned in full.
 */
export const settlementPnl = (row: ValueBetRow, stake: number): number => {
  if (row.outcome === "won" || row.outcome === "half_won") {
    const cf = commissionFactor(row.softCommissionPct);
    const frac = row.outcome === "half_won" ? 0.5 : 1;
    return frac * stake * (row.softOddsFirst - 1) * cf;
  }
  if (row.outcome === "lost") return -stake;
  if (row.outcome === "half_lost") return -0.5 * stake;
  return 0;
};
