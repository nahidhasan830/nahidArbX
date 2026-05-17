/**
 * Two-sample Sharpe-ratio comparison via the Opdyke PSR test.
 *
 * Compares whether group B's risk-adjusted return is statistically
 * better than group A's. The Opdyke test (2003) extends the
 * Probabilistic Sharpe Ratio to two samples, accounting for skew,
 * kurtosis, and the correlation between the two return series —
 * critical when the groups overlap (e.g. boost-vs-control on
 * the same underlying bets).
 *
 * Used by the stake-increase pilot to compare boosted-stake bets
 * against unboosted-stake bets within the same model. Was previously
 * also used for champion-vs-challenger model promotion; that concept
 * has been removed — a validated model just deploys.
 *
 * References:
 *   - Opdyke, J.D. (2003), "Comparing Sharpe Ratios: So Where are the p-values?"
 *   - Bailey & López de Prado (2014), "The Deflated Sharpe Ratio"
 */

// ── Constants ─────────────────────────────────────────────────────────

/** Minimum number of overlapping samples for a valid comparison. */
export const MIN_OVERLAP_SAMPLES = 30;

// ── Types ─────────────────────────────────────────────────────────────

export interface GroupReturns {
  /** Identifier for diagnostics (e.g. model version, "boost", "control"). */
  label: string;
  /** Per-bet unit returns. */
  unitReturns: number[];
  /** Total number of bets evaluated on. */
  sampleSize: number;
}

export interface SharpeComparisonResult {
  /** PSR that group B beats group A on Sharpe ratio [0, 1]. */
  psr: number;
  /** Z-statistic of the Opdyke test. */
  zStat: number;
  /** Group A's mean unit return. */
  aMean: number;
  /** Group B's mean unit return. */
  bMean: number;
  /** Number of overlapping samples used in the test. */
  overlapSamples: number;
  /** Group A's Sharpe ratio. */
  aSharpe: number;
  /** Group B's Sharpe ratio. */
  bSharpe: number;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Compare two groups' risk-adjusted returns. PSR is the probability
 * that group B has a strictly higher true Sharpe ratio than group A,
 * given the observed data.
 *
 * Both groups should be evaluated on overlapping bets for the
 * correlation correction to bite. The function truncates both arrays
 * to the same length before testing.
 */
export function compareGroupSharpes(
  a: GroupReturns,
  b: GroupReturns,
): SharpeComparisonResult {
  const n = Math.min(a.unitReturns.length, b.unitReturns.length);
  const aReturns = a.unitReturns.slice(0, n);
  const bReturns = b.unitReturns.slice(0, n);

  const aMean = computeMean(aReturns);
  const bMean = computeMean(bReturns);

  if (n < MIN_OVERLAP_SAMPLES) {
    return {
      psr: 0,
      zStat: 0,
      aMean,
      bMean,
      overlapSamples: n,
      aSharpe: 0,
      bSharpe: 0,
    };
  }

  // ── Opdyke two-sample test ───────────────────────────────────────

  const aSharpe = computeSharpe(aReturns);
  const bSharpe = computeSharpe(bReturns);

  // Individual Sharpe variances (LdP 2014 eqn)
  const aVar = sharpeVariance(aReturns, aSharpe);
  const bVar = sharpeVariance(bReturns, bSharpe);

  // Correlation between the two return series
  const rho = computeCorrelation(aReturns, bReturns);

  // Opdyke variance of the difference
  const diffVariance = aVar + bVar - 2 * rho * Math.sqrt(aVar * bVar);

  const zStat =
    diffVariance > 0 ? (bSharpe - aSharpe) / Math.sqrt(diffVariance) : 0;

  // PSR = P(true B Sharpe > true A Sharpe | observed data)
  const psr = normalCDF(zStat);

  return {
    psr,
    zStat,
    aMean,
    bMean,
    overlapSamples: n,
    aSharpe,
    bSharpe,
  };
}

// ── Statistical helpers ───────────────────────────────────────────────

function computeMean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((acc, v) => acc + v, 0) / arr.length;
}

function computeStdDev(arr: number[], mean?: number): number {
  if (arr.length < 2) return 0;
  const mu = mean ?? computeMean(arr);
  const variance =
    arr.reduce((sum, v) => sum + (v - mu) ** 2, 0) / (arr.length - 1);
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
  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return 0.5 * (1.0 + sign * y);
}
