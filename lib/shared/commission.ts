/**
 * Commission Calculations
 *
 * Commission is charged by betting exchanges on NET WINNINGS (profit), not on stake.
 * This affects the effective odds you receive.
 *
 * Formula: AdjustedOdds = 1 + ((1 - commissionRate) * (rawOdds - 1))
 *
 * Example: 3.00 odds with 5% commission
 *   = 1 + ((1 - 0.05) * (3.00 - 1))
 *   = 1 + (0.95 * 2)
 *   = 2.90 effective odds
 */

/**
 * Calculate commission-adjusted odds.
 *
 * Converts raw odds to effective odds after commission is applied.
 * Commission only affects winnings, so odds of 1.00 remain unchanged.
 *
 * @param rawOdds - Original odds from provider
 * @param commissionPct - Commission percentage (0-100), e.g., 5 for 5%
 * @returns Effective odds after commission
 *
 * @example
 * adjustOddsForCommission(3.00, 5)  // Returns 2.90
 * adjustOddsForCommission(2.00, 10) // Returns 1.90
 * adjustOddsForCommission(1.50, 0)  // Returns 1.50 (no commission)
 */
export function adjustOddsForCommission(
  rawOdds: number,
  commissionPct: number,
): number {
  // Edge cases: invalid odds or no commission
  if (rawOdds <= 1 || commissionPct <= 0) {
    return rawOdds;
  }

  // Clamp commission to valid range
  const clampedCommission = Math.min(Math.max(commissionPct, 0), 100);
  const commissionRate = clampedCommission / 100;

  // Formula: 1 + ((1 - commissionRate) * (odds - 1))
  return 1 + (1 - commissionRate) * (rawOdds - 1);
}

/**
 * Calculate commission amount on a winning bet.
 *
 * Commission is only charged on profit (return - stake), not on stake itself.
 *
 * @param stake - Amount staked
 * @param odds - Odds at which bet was placed (raw, unadjusted)
 * @param commissionPct - Commission percentage (0-100)
 * @returns Commission amount deducted from winnings
 *
 * @example
 * calculateCommission(100, 3.00, 5)  // Returns 10 (5% of 200 profit)
 * calculateCommission(100, 2.00, 5)  // Returns 5 (5% of 100 profit)
 */
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

/**
 * Calculate gross return before commission.
 *
 * @param stake - Amount staked
 * @param odds - Odds at which bet was placed
 * @returns Gross return (stake * odds)
 */
export function calculateGrossReturn(stake: number, odds: number): number {
  return stake * odds;
}

/**
 * Calculate net return after commission.
 *
 * This is what you actually receive if the bet wins.
 *
 * @param stake - Amount staked
 * @param odds - Odds at which bet was placed (raw, unadjusted)
 * @param commissionPct - Commission percentage (0-100)
 * @returns Net return after commission is deducted
 *
 * @example
 * calculateNetReturn(100, 3.00, 5)  // Returns 290 (300 - 10 commission)
 * calculateNetReturn(100, 2.00, 5)  // Returns 195 (200 - 5 commission)
 */
export function calculateNetReturn(
  stake: number,
  odds: number,
  commissionPct: number,
): number {
  const grossReturn = calculateGrossReturn(stake, odds);
  const commission = calculateCommission(stake, odds, commissionPct);
  return grossReturn - commission;
}

/**
 * Calculate net profit after commission.
 *
 * @param stake - Amount staked
 * @param odds - Odds at which bet was placed (raw, unadjusted)
 * @param commissionPct - Commission percentage (0-100)
 * @returns Net profit after commission (net return - stake)
 *
 * @example
 * calculateNetProfit(100, 3.00, 5)  // Returns 190 (290 - 100 stake)
 */
export function calculateNetProfit(
  stake: number,
  odds: number,
  commissionPct: number,
): number {
  return calculateNetReturn(stake, odds, commissionPct) - stake;
}
