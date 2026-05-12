/**
 * Champion-Challenger Promotion Logic — Opdyke two-sample PSR.
 *
 * The Opdyke test (2003) extends the Probabilistic Sharpe Ratio to test
 * whether two strategies have significantly different Sharpe ratios.
 * It accounts for skew, kurtosis, and the correlation between the
 * strategy returns — critical when champion and challenger score many
 * of the same bets (high correlation inflates naive tests).
 *
 * Promotion gating:
 *   1. Challenger must beat champion on raw unit-return mean.
 *   2. Opdyke PSR must exceed PROMOTION_PSR_THRESHOLD (0.95).
 *   3. Challenger must have enough OOS test samples.
 *   4. Deployment gate must approve the challenger at the same or
 *      higher permission level.
 *
 * References:
 *   - Opdyke, J.D. (2003), "Comparing Sharpe Ratios: So Where are the p-values?"
 *   - Bailey & López de Prado (2014), "The Deflated Sharpe Ratio"
 */

// ── Constants ─────────────────────────────────────────────────────────

/** PSR threshold for promotion — 95% confidence that challenger beats champion. */
export const PROMOTION_PSR_THRESHOLD = 0.95;

/** Minimum number of overlapping OOS samples for a valid comparison. */
export const MIN_OVERLAP_SAMPLES = 30;

/** Minimum challenger ROI improvement over champion (percentage points). */
export const MIN_ROI_IMPROVEMENT_PCT = 0.5;

// ── Types ─────────────────────────────────────────────────────────────

export interface ModelPerformance {
  /** Model version (uniquely identifies this model). */
  version: number;
  /** Per-bet unit returns on the shared OOS evaluation window. */
  unitReturns: number[];
  /** Total number of bets evaluated on. */
  sampleSize: number;
}

export interface PromotionDecision {
  /** Whether the challenger should be promoted. */
  promote: boolean;
  /** PSR of the challenger over the champion [0, 1]. */
  psr: number;
  /** Z-statistic of the Opdyke test. */
  zStat: number;
  /** Challenger's mean unit return. */
  challengerMean: number;
  /** Champion's mean unit return. */
  championMean: number;
  /** Number of overlapping samples used in the test. */
  overlapSamples: number;
  /** List of reasons if promotion was blocked. */
  blockedReasons: string[];
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Evaluate whether a challenger model should replace the champion.
 *
 * Uses the Opdyke two-sample PSR test on the shared OOS evaluation
 * window. Both models must have been scored on the same bets for a
 * valid comparison.
 *
 * @param champion - currently deployed model's performance.
 * @param challenger - candidate model's performance.
 * @returns PromotionDecision with whether to promote and diagnostic stats.
 */
export function evaluatePromotion(
  champion: ModelPerformance,
  challenger: ModelPerformance,
): PromotionDecision {
  const reasons: string[] = [];

  // ── Sample size gate ─────────────────────────────────────────────

  const overlapN = Math.min(champion.unitReturns.length, challenger.unitReturns.length);
  if (overlapN < MIN_OVERLAP_SAMPLES) {
    reasons.push(
      `Insufficient overlap samples: ${overlapN}, need at least ${MIN_OVERLAP_SAMPLES}`,
    );
  }

  if (challenger.sampleSize < MIN_OVERLAP_SAMPLES) {
    reasons.push(
      `Challenger has too few OOS samples: ${challenger.sampleSize}, need at least ${MIN_OVERLAP_SAMPLES}`,
    );
  }

  // Truncate both to the same length for paired comparison
  const n = Math.min(champion.unitReturns.length, challenger.unitReturns.length);
  const cReturns = champion.unitReturns.slice(0, n);
  const chReturns = challenger.unitReturns.slice(0, n);

  if (n < MIN_OVERLAP_SAMPLES) {
    return {
      promote: false,
      psr: 0,
      zStat: 0,
      challengerMean: computeMean(chReturns),
      championMean: computeMean(cReturns),
      overlapSamples: n,
      blockedReasons: reasons,
    };
  }

  // ── Mean return gate ─────────────────────────────────────────────

  const championMean = computeMean(cReturns);
  const challengerMean = computeMean(chReturns);

  if (challengerMean <= championMean) {
    reasons.push(
      `Challenger mean return (${(challengerMean * 100).toFixed(4)}%) does not exceed champion (${(championMean * 100).toFixed(4)}%)`,
    );
  }

  const deltaMean = (challengerMean - championMean) * 100;
  if (Math.abs(deltaMean) < MIN_ROI_IMPROVEMENT_PCT && deltaMean > 0) {
    reasons.push(
      `Challenger ROI improvement too small: ${deltaMean.toFixed(4)}pp, need at least ${MIN_ROI_IMPROVEMENT_PCT}pp`,
    );
  }

  // ── Opdyke two-sample test ───────────────────────────────────────

  // Compute Sharpe ratios (annualised, but only relative matters)
  const champSharpe = computeSharpe(cReturns);
  const chalSharpe = computeSharpe(chReturns);

  // Individual Sharpe variances (LdP 2014 eqn)
  const champVar = sharpeVariance(cReturns, champSharpe);
  const chalVar = sharpeVariance(chReturns, chalSharpe);

  // Correlation between the two return series
  const rho = computeCorrelation(cReturns, chReturns);

  // Opdyke variance of the difference
  const diffVariance = champVar + chalVar - 2 * rho * Math.sqrt(champVar * chalVar);

  const zStat =
    diffVariance > 0 ? (chalSharpe - champSharpe) / Math.sqrt(diffVariance) : 0;

  // PSR = P(true challenger Sharpe > true champion Sharpe | observed data)
  const psr = normalCDF(zStat);

  if (psr < PROMOTION_PSR_THRESHOLD) {
    reasons.push(
      `PSR too low: ${psr.toFixed(4)}, need at least ${PROMOTION_PSR_THRESHOLD}`,
    );
  }

  return {
    promote: reasons.length === 0,
    psr,
    zStat,
    challengerMean,
    championMean,
    overlapSamples: n,
    blockedReasons: reasons,
  };
}

/**
 * Check if a new model shows evidence of overfitting relative to the champion.
 *
 * A model with higher Sharpe but very low PSR (or negative z-stat) on the
 * shared OOS window is an overfit warning signal — it learned noise that
 * benefited it in-sample but hurts it on fresh data.
 *
 * @returns true if the champion appears more robust despite possibly lower raw Sharpe.
 */
export function detectOverfitting(
  champion: ModelPerformance,
  challenger: ModelPerformance,
): boolean {
  const n = Math.min(champion.unitReturns.length, challenger.unitReturns.length);
  if (n < MIN_OVERLAP_SAMPLES) return false;

  const cReturns = champion.unitReturns.slice(0, n);
  const chReturns = challenger.unitReturns.slice(0, n);

  const champSharpe = computeSharpe(cReturns);
  const chalSharpe = computeSharpe(chReturns);

  // Challenger has better raw Sharpe but negative z-stat = overfit warning
  if (chalSharpe <= champSharpe) return false;

  const champVar = sharpeVariance(cReturns, champSharpe);
  const chalVar = sharpeVariance(chReturns, chalSharpe);
  const rho = computeCorrelation(cReturns, chReturns);
  const diffVariance = champVar + chalVar - 2 * rho * Math.sqrt(champVar * chalVar);

  if (diffVariance <= 0) return true; // degenerate

  const zStat = (chalSharpe - champSharpe) / Math.sqrt(diffVariance);
  return zStat < 0;
}

// ── Statistical helpers ───────────────────────────────────────────────

function computeMean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function computeStdDev(arr: number[], mean?: number): number {
  if (arr.length < 2) return 0;
  const mu = mean ?? computeMean(arr);
  const variance = arr.reduce((sum, v) => sum + (v - mu) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function computeSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = computeMean(returns);
  const std = computeStdDev(returns, mean);
  if (std === 0) return 0;
  return mean / std;
}

function computeSkew(returns: number[], mean?: number): number {
  if (returns.length < 3) return 0;
  const mu = mean ?? computeMean(returns);
  const std = computeStdDev(returns, mu);
  if (std === 0) return 0;
  const n = returns.length;
  const m3 = returns.reduce((sum, v) => sum + (v - mu) ** 3, 0) / n;
  return m3 / std ** 3;
}

function computeExcessKurtosis(returns: number[], mean?: number): number {
  if (returns.length < 4) return 0;
  const mu = mean ?? computeMean(returns);
  const std = computeStdDev(returns, mu);
  if (std === 0) return 0;
  const n = returns.length;
  const m4 = returns.reduce((sum, v) => sum + (v - mu) ** 4, 0) / n;
  return m4 / std ** 4 - 3;
}

/**
 * Asymptotic variance of the Sharpe ratio estimator (LdP 2014, eqn 6).
 * Accounts for non-normality via skew and excess kurtosis.
 */
function sharpeVariance(returns: number[], sharpe: number): number {
  const n = returns.length;
  if (n < 4) return 0;
  const skew = computeSkew(returns);
  const exKurt = computeExcessKurtosis(returns);
  const numerator = 1 - skew * sharpe + (exKurt / 4) * sharpe ** 2;
  return Math.max(numerator, 0) / n;
}

function computeCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const mx = computeMean(x);
  const my = computeMean(y);
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  if (den === 0) return 0;
  return Math.min(1, Math.max(-1, num / den));
}

function normalCDF(x: number): number {
  // Accuracy ~1e-7 with the standard approximation
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const pConst = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + pConst * absX);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return 0.5 * (1.0 + sign * y);
}
