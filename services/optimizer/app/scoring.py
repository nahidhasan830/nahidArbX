"""Statistical scoring: Deflated Sharpe, Probabilistic Sharpe, composite.

The Deflated Sharpe Ratio (DSR) discounts a strategy's reported Sharpe
based on (a) the number of independent trials we conducted and (b) the
non-normality (skew + kurtosis) of its returns. It's the statistical
formalization of "the more configs you trial, the more luck looks like
skill". Closed form: Bailey & López de Prado, 2014.

Probabilistic Sharpe Ratio (PSR) is the probability that the *true* Sharpe
exceeds a benchmark, given the estimated one. PSR > 0.95 is roughly
"statistically significant at the 5% level".

Composite score collapses everything into one scalar that the sampler
optimizes. It penalizes (a) small samples, (b) large drawdowns, and (c)
DSR/PSR-detected overfitting.
"""

from __future__ import annotations

import math

import numpy as np
from scipy import stats


def probabilistic_sharpe(
    sharpe_hat: float,
    *,
    n: int,
    skew: float = 0.0,
    kurtosis: float = 3.0,
    benchmark_sharpe: float = 0.0,
) -> float:
    """P(true Sharpe > benchmark | observed Sharpe). Returns 0..1."""
    if n < 2:
        return 0.5
    excess_kurt = kurtosis - 3.0
    denom_sq = 1.0 - skew * sharpe_hat + ((excess_kurt) / 4.0) * sharpe_hat**2
    denom = math.sqrt(max(denom_sq, 1e-12) / (n - 1))
    z = (sharpe_hat - benchmark_sharpe) / max(denom, 1e-12)
    return float(stats.norm.cdf(z))


def deflated_sharpe(
    sharpe_hat: float,
    *,
    n: int,
    n_trials: int,
    sharpe_variance_across_trials: float,
    skew: float = 0.0,
    kurtosis: float = 3.0,
) -> float:
    """Deflated Sharpe Ratio (Bailey & López de Prado, 2014).

    Returns the PSR with the benchmark Sharpe set to the *expected maximum*
    over `n_trials` independent trials. Equivalently: how confident we
    should be that this trial's Sharpe is real, after accounting for the
    multiple-testing inflation.
    """
    if n_trials < 2:
        return probabilistic_sharpe(sharpe_hat, n=n, skew=skew, kurtosis=kurtosis)

    # Expected max of n_trials normal samples with variance `var_sharpe`.
    # Approximation from Bailey & López de Prado (2014), eqn (15):
    #   E[max] ≈ sqrt(var) × ((1-γ) Φ⁻¹(1-1/M) + γ Φ⁻¹(1-1/(M·e)))
    # where γ is the Euler-Mascheroni constant.
    em = 0.5772156649  # Euler-Mascheroni
    z1 = stats.norm.ppf(1.0 - 1.0 / n_trials)
    z2 = stats.norm.ppf(1.0 - 1.0 / (n_trials * math.e))
    expected_max = math.sqrt(max(sharpe_variance_across_trials, 0.0)) * (
        (1.0 - em) * z1 + em * z2
    )
    return probabilistic_sharpe(
        sharpe_hat,
        n=n,
        skew=skew,
        kurtosis=kurtosis,
        benchmark_sharpe=expected_max,
    )


# Absolute floor: trials with fewer than this many OOS bets are clamped
# below any real-n trial. Rationale: Bayesian-shrunk ROI alone isn't
# enough to stop a 5-bet outlier (+48% ROI) from winning when the rest
# of the field has n=0 sentinels — we observed this on prod 2026-04-24
# (run 00MOCZZ72WEZZXYKCZSW7PYIDO). 30 is Bailey & López de Prado's
# practical minimum for Sharpe CI stability; below that the statistics
# simply aren't meaningful.
MIN_SAMPLE_FOR_CREDIT = 30

# Sentinel composite score for trials with ZERO bets surviving filters.
ZERO_SAMPLE_SENTINEL = -1e9

# Floor range for trials with 0 < n < MIN_SAMPLE_FOR_CREDIT. Still worse
# than every legitimate trial, but monotonically increases in n so the
# Pareto+sampler can distinguish "filter almost works" from "filter is
# a cliff". Range: [-1000, -1] linearly interpolated over [1, 29].
LOW_SAMPLE_MIN = -1000.0
LOW_SAMPLE_MAX = -1.0


def composite_score(
    *,
    oos_roi_mean: float,
    sample_size: int,
    max_drawdown: float,
    deflated_sharpe_score: float,
    drawdown_lambda: float = 0.5,
    min_n_for_full_credit: int = 100,
) -> float:
    """Single scalar the sampler maximizes. Guards against tiny-sample
    flukes so that e.g. a 5-bet +48% ROI trial does NOT outrank a real
    4,000-bet trial.

    Bands:
    - `n == 0`                         → ZERO_SAMPLE_SENTINEL (-1e9)
    - `0 < n < MIN_SAMPLE_FOR_CREDIT`  → interpolated low-sample penalty
      in [LOW_SAMPLE_MIN, LOW_SAMPLE_MAX], monotonic in n. Stays strictly
      below any legitimate trial, so a Bayesian-shrunk outlier can't win.
    - `n ≥ MIN_SAMPLE_FOR_CREDIT`      → full composite formula:
        shrunk_roi · log1p(n) · max(DSR, 0) − drawdown_lambda · max_dd
    """
    if sample_size <= 0:
        return ZERO_SAMPLE_SENTINEL

    if sample_size < MIN_SAMPLE_FOR_CREDIT:
        # Linearly walk from LOW_SAMPLE_MIN (n=1) → LOW_SAMPLE_MAX
        # (n=MIN_SAMPLE_FOR_CREDIT−1). Gradient purely in n so the
        # sampler is still nudged toward configs with more surviving
        # bets, without letting any of them reach the real-trial band.
        span = LOW_SAMPLE_MAX - LOW_SAMPLE_MIN
        progress = (sample_size - 1) / max(MIN_SAMPLE_FOR_CREDIT - 1, 1)
        return float(LOW_SAMPLE_MIN + progress * span)

    # Shrinkage: weight = n / (n + min_n) → 0 when n→0, → 1 when n>>min_n.
    weight = sample_size / (sample_size + min_n_for_full_credit)
    shrunk_roi = oos_roi_mean * weight

    sample_factor = math.log1p(sample_size)
    dsr_multiplier = max(deflated_sharpe_score, 0.0)  # PSR/DSR is in [0,1]

    base = shrunk_roi * sample_factor * dsr_multiplier
    penalty = drawdown_lambda * max_drawdown
    return float(base - penalty)


def trial_sharpe_variance(per_trial_sharpes: list[float]) -> float:
    """Variance of Sharpe estimates across trials — input to DSR."""
    if len(per_trial_sharpes) < 2:
        return 0.0
    return float(np.var(np.array(per_trial_sharpes, dtype=np.float64), ddof=1))


# ── Probability of Backtest Overfitting (PBO) ──────────────────────────────
#
# Bailey, Borwein, López de Prado, Zhu (2017). Approach: take the per-trial
# OOS metrics matrix (trials × cv_paths). Split the cv_paths into two halves
# many times. For each split, compute each trial's mean metric in the train
# half, pick the BEST trial, then look at where that trial's rank falls in
# the test half. Probability the best in-sample is in the bottom half OOS
# = PBO. Lower is better; PBO < 5% = excellent, > 30% = your search is too
# aggressive for your sample size.


def pbo_score(
    fold_metrics_per_trial: list[list[float]],
    *,
    n_subsamples: int = 200,
    seed: int = 0,
) -> float:
    """Returns PBO in [0, 1].

    `fold_metrics_per_trial[i][j]` = trial i's OOS metric on path j.
    Trials must all share the same number of paths.
    """
    if not fold_metrics_per_trial:
        return 0.0
    n_trials = len(fold_metrics_per_trial)
    if n_trials < 2:
        return 0.0
    n_paths = len(fold_metrics_per_trial[0])
    if n_paths < 4:
        # Need at least 4 paths to split into two halves of 2.
        return 0.0

    arr = np.array(fold_metrics_per_trial, dtype=np.float64)
    rng = np.random.default_rng(seed)
    half = n_paths // 2

    # Replace NaN/inf with 0 so a degenerate fold doesn't tank the rank.
    arr = np.where(np.isfinite(arr), arr, 0.0)

    misses = 0
    for _ in range(n_subsamples):
        path_perm = rng.permutation(n_paths)
        train_paths = path_perm[:half]
        test_paths = path_perm[half : 2 * half]

        train_means = arr[:, train_paths].mean(axis=1)
        test_means = arr[:, test_paths].mean(axis=1)

        best_in_sample = int(np.argmax(train_means))
        # Rank of the best-IS trial among the others on test_means.
        # Higher rank = better. Bottom-half rank means PBO event.
        ranks = np.argsort(np.argsort(test_means))  # 0..n-1 ascending
        if ranks[best_in_sample] < n_trials // 2:
            misses += 1

    return float(misses / n_subsamples)


# ── White's Reality Check ──────────────────────────────────────────────────
#
# Tests whether the BEST observed strategy beats a baseline (typically
# zero) by more than chance. Bootstrap-based; returns a p-value. Lower
# = stronger evidence of real signal vs. baseline.
#
# Implementation: for each bootstrap resample of the per-path returns,
# compute the max-mean-return across trials. p-value = fraction of
# bootstrap samples where the max is ≥ the observed max.


def whites_reality_check_pvalue(
    fold_metrics_per_trial: list[list[float]],
    *,
    benchmark_mean: float = 0.0,
    n_bootstraps: int = 500,
    seed: int = 0,
) -> float:
    """Returns p-value in [0, 1]. < 0.05 = reject null at 5%."""
    if not fold_metrics_per_trial:
        return 1.0
    n_trials = len(fold_metrics_per_trial)
    n_paths = len(fold_metrics_per_trial[0])
    if n_paths < 3 or n_trials < 1:
        return 1.0

    arr = np.array(fold_metrics_per_trial, dtype=np.float64)
    arr = np.where(np.isfinite(arr), arr, 0.0)

    # Per-trial mean over its OOS paths, then the observed max-trial mean.
    centered = arr - benchmark_mean  # null hypothesis: mean == benchmark
    observed_max = float(centered.mean(axis=1).max())

    rng = np.random.default_rng(seed)
    misses = 0
    for _ in range(n_bootstraps):
        idx = rng.integers(0, n_paths, size=n_paths)
        sample = centered[:, idx]
        # Centre each trial's bootstrap mean by subtracting its observed mean.
        # Standard "stationary bootstrap" approach for WRC: resampled mean
        # under the null distribution.
        bootstrap_means = sample.mean(axis=1) - centered.mean(axis=1)
        if bootstrap_means.max() >= observed_max:
            misses += 1
    return float(misses / n_bootstraps)
