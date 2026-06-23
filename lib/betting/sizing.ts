export interface EdgeInputs {
  softOdds: number;
  softCommissionPct: number;
  sharpTrueProb: number;
}

export interface EdgeResult {
  evPct: number;
  fullKelly: number;
  adjustedOdds: number;
}

export interface StakeInputs {
  fullKelly: number;
  bankrollBdt: number;
  kellyCapPct: number;
  kellyFraction: number;
}

export function deriveEdge(row: EdgeInputs): EdgeResult {
  const adjustedOdds =
    1 + (row.softOdds - 1) * (1 - row.softCommissionPct / 100);
  const p = row.sharpTrueProb;
  const b = adjustedOdds - 1;
  const evPct = (adjustedOdds * p - 1) * 100;
  const fullKelly = b > 0 ? (b * p - (1 - p)) / b : 0;
  return { evPct, fullKelly, adjustedOdds };
}

export function computeStake({
  fullKelly,
  bankrollBdt,
  kellyCapPct,
  kellyFraction,
}: StakeInputs): number {
  const kelly = Math.max(0, fullKelly);
  const frac = Math.max(0, Math.min(1, kellyFraction));
  const cap = bankrollBdt * (kellyCapPct / 100);
  return Math.min(kelly * frac * bankrollBdt, cap);
}
