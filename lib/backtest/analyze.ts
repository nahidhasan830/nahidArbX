import { derive, settlementPnl } from "./derive";
import {
  isSettledOutcome,
  type StrategyId,
  type StrategyMetrics,
  type ValueBetRow,
} from "./types";

export const STRATEGIES: { id: StrategyId; label: string }[] = [
  { id: "flat", label: "Flat 1u" },
  { id: "kelly", label: "Full Kelly" },
  { id: "frac-kelly-0.5", label: "Kelly × 0.5" },
  { id: "frac-kelly-0.25", label: "Kelly × 0.25" },
  { id: "ev-prop", label: "EV-proportional" },
];

const stakeFor = (row: ValueBetRow, strategy: StrategyId): number => {
  const { kellyFractionFirst, evPctFirst } = derive(row);
  switch (strategy) {
    case "flat":
      return 1;
    case "kelly":
      return kellyFractionFirst * 4;
    case "frac-kelly-0.5":
      return kellyFractionFirst * 2;
    case "frac-kelly-0.25":
      return kellyFractionFirst * 1;
    case "ev-prop":
      return Math.max(0, evPctFirst / 100) * 4;
  }
};

const settlementReturn = (row: ValueBetRow, stake: number): number =>
  settlementPnl(row, stake);

export const computeStrategyMetrics = (
  rows: ValueBetRow[],
  strategy: StrategyId,
): StrategyMetrics => {
  const settled = rows
    .filter((r) => isSettledOutcome(r.outcome))
    .sort((a, b) =>
      (a.outcomeMarkedAt ?? a.firstSeenAt).localeCompare(
        b.outcomeMarkedAt ?? b.firstSeenAt,
      ),
    );

  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  let totalStaked = 0;
  let totalReturn = 0;
  let wins = 0;
  let halfWins = 0;
  let losses = 0;
  let halfLosses = 0;
  let voids = 0;

  const curve: { index: number; equity: number; markedAt: string }[] = [];
  curve.push({
    index: 0,
    equity: 0,
    markedAt: settled[0]?.outcomeMarkedAt ?? new Date().toISOString(),
  });

  settled.forEach((row, idx) => {
    const stake = stakeFor(row, strategy);
    const ret = settlementReturn(row, stake);
    totalStaked += stake;
    totalReturn += ret;
    equity += ret;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
    if (row.outcome === "won") wins++;
    else if (row.outcome === "half_won") halfWins++;
    else if (row.outcome === "lost") losses++;
    else if (row.outcome === "half_lost") halfLosses++;
    else voids++;
    curve.push({
      index: idx + 1,
      equity: Number(equity.toFixed(4)),
      markedAt: row.outcomeMarkedAt ?? row.firstSeenAt,
    });
  });

  const decided = wins + halfWins + losses + halfLosses;
  // Weighted: a half-win counts as 0.5 of a win, a half-loss as 0.5 of a loss.
  const weightedWins = wins + 0.5 * halfWins;
  const winRate = decided > 0 ? weightedWins / decided : 0;
  const roiPct = totalStaked > 0 ? (totalReturn / totalStaked) * 100 : 0;

  const label = STRATEGIES.find((s) => s.id === strategy)?.label ?? strategy;

  return {
    strategy,
    label,
    totalBets: rows.length,
    settledBets: settled.length,
    wins,
    halfWins,
    losses,
    halfLosses,
    voids,
    winRate,
    totalStaked: Number(totalStaked.toFixed(4)),
    totalReturn: Number(totalReturn.toFixed(4)),
    roiPct: Number(roiPct.toFixed(3)),
    maxDrawdown: Number(maxDD.toFixed(4)),
    equityCurve: curve,
  };
};
