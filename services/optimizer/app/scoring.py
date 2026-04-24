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


def composite_score(
    *,
    oos_roi_mean: float,
    sample_size: int,
    max_drawdown: float,
    deflated_sharpe_score: float,
    drawdown_lambda: float = 0.5,
    min_n_for_full_credit: int = 100,
) -> float:
    """Single scalar the sampler maximizes.

    Components:
    - Bayesian-shrunk ROI: shrinks toward zero when n is small (anti-overfit).
    - log(1+n) factor: rewards larger samples but with diminishing returns.
    - DSR multiplier: scales final score by 0..1 confidence.
    - Drawdown penalty: subtractive, scaled by `drawdown_lambda`.
    """
    if sample_size <= 0:
        return -1e9

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
