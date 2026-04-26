/**
 * Velki currency-unit normalization.
 *
 * Velki's APIs return monetary amounts in a unit where `1 = 100 BDT`.
 * The Velki web UI itself displays these unscaled (so a player with
 * 3,030 BDT sees "30.30" in the corner pill) — but our app
 * standardises on plain BDT throughout, so we multiply at the server
 * boundary, before any value reaches the frontend / dashboard /
 * placement modal.
 *
 * Affected fields:
 *   • queryPlayerInfo  — betCredit, totalExposure, creditAllocated, minBet
 *   • /account/wallet  — credit_balance, available_credit_balance,
 *                        coin_balance, exposure_limit
 *   • /turnover/list   — base_amount, required_turnover_amount,
 *                        complete_turnover_amount  (strings → BDT numbers)
 *   • Genius Sports markets — min, max stake limits per market
 *
 * Odds, percentages, IDs, and timestamps are NOT scaled. Anything that
 * looks like "BDT money" is.
 *
 * If the platform ever changes scale (e.g. switches to plain BDT), flip
 * `VELKI_AMOUNT_SCALE` to 1 here — every consumer downstream stays
 * untouched.
 */

export const VELKI_AMOUNT_SCALE = 100;

/** Scale a Velki-unit number to plain BDT. Pass null/undefined through. */
export function toBDT(value: number): number;
export function toBDT(value: number | null): number | null;
export function toBDT(value: number | undefined): number | undefined;
export function toBDT(
  value: number | null | undefined,
): number | null | undefined {
  if (value === null || value === undefined) return value;
  return value * VELKI_AMOUNT_SCALE;
}

/**
 * Parse a Velki-unit string (e.g. "20.0000" from /turnover/list) and
 * scale to plain BDT. Returns NaN if unparseable, matching parseFloat.
 */
export function toBDTFromString(value: string): number {
  const parsed = parseFloat(value);
  if (Number.isNaN(parsed)) return NaN;
  return parsed * VELKI_AMOUNT_SCALE;
}
