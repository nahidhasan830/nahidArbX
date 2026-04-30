import type { ValueBetRow } from "./types";

export type DerivedMetrics = {
  softOddsAdjusted: number;
  sharpTrueOdds: number;
  evPct: number;
  kellyFraction: number;
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
  const softOddsAdjusted = 1 + (row.softOdds - 1) * cf;
  const sharpTrueOdds = 1 / row.sharpTrueProb;
  const evPct = (softOddsAdjusted * row.sharpTrueProb - 1) * 100;
  const kellyFrac = kellyFraction(softOddsAdjusted, row.sharpTrueProb);
  return {
    softOddsAdjusted,
    sharpTrueOdds,
    evPct,
    kellyFraction: kellyFrac,
  };
};

export const kellyStake = (
  row: ValueBetRow,
  bankroll: number,
  kellyMultiplier = 1,
): number => {
  const { kellyFraction } = derive(row);
  return kellyFraction * kellyMultiplier * bankroll;
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
      const { evPct } = derive(row);
      return Math.min(
        strategy.cap,
        Math.max(0, evPct / 100) * strategy.bankroll,
      );
    }
  }
};

/**
 * P&L for a settled row given a stake.
 *
 * Wins are booked at softOdds — the price at first detection, which is
 * the realistic entry price. closingSharpOdds is used for CLV analysis
 * only, not for P&L.
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
    return frac * stake * (row.softOdds - 1) * cf;
  }
  if (row.outcome === "lost") return -stake;
  if (row.outcome === "half_lost") return -0.5 * stake;
  return 0;
};
