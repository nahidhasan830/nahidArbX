
export function adjustOddsForCommission(
  rawOdds: number,
  commissionPct: number,
): number {
  if (rawOdds <= 1 || commissionPct <= 0) {
    return rawOdds;
  }

  const clampedCommission = Math.min(Math.max(commissionPct, 0), 100);
  const commissionRate = clampedCommission / 100;

  return 1 + (1 - commissionRate) * (rawOdds - 1);
}

export function calculateCommission(
  stake: number,
  odds: number,
  commissionPct: number,
): number {
  if (stake <= 0 || odds <= 1 || commissionPct <= 0) {
    return 0;
  }

  const grossReturn = stake * odds;
  const profit = grossReturn - stake;
  const clampedCommission = Math.min(Math.max(commissionPct, 0), 100);

  return profit * (clampedCommission / 100);
}

export function calculateGrossReturn(stake: number, odds: number): number {
  return stake * odds;
}

export function calculateNetReturn(
  stake: number,
  odds: number,
  commissionPct: number,
): number {
  const grossReturn = calculateGrossReturn(stake, odds);
  const commission = calculateCommission(stake, odds, commissionPct);
  return grossReturn - commission;
}

export function calculateNetProfit(
  stake: number,
  odds: number,
  commissionPct: number,
): number {
  return calculateNetReturn(stake, odds, commissionPct) - stake;
}
