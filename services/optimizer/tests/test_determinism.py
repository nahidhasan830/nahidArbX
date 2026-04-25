"""Determinism regression.

Same input + same seed MUST produce bitwise-identical output. This
test catches silent non-determinism from library upgrades, Polars
internal ordering changes, or accidental reliance on dict-iteration
order.
"""

from __future__ import annotations

from dataclasses import asdict

from app.bootstrap import stationary_bootstrap_ci
from app.cpcv import CpcvConfig, make_cpcv_splits
from app.evaluator import evaluate_trial
from app.scoring import deflated_sharpe, pbo_score, probabilistic_sharpe
import numpy as np


def test_evaluate_trial_is_bitwise_deterministic(zero_edge_bets, default_config):
    """Same df + same config + same splits must produce identical TrialResult."""
    df = zero_edge_bets
    splits = make_cpcv_splits(df, CpcvConfig(n_groups=10, n_test_groups=2))

    r1 = evaluate_trial(df, splits, default_config)
    r2 = evaluate_trial(df, splits, default_config)

    assert r1.sample_size == r2.sample_size
    assert r1.oos_roi_mean == r2.oos_roi_mean
    assert r1.oos_sharpe == r2.oos_sharpe
    assert r1.oos_sortino == r2.oos_sortino
    assert r1.max_drawdown == r2.max_drawdown
    assert r1.win_rate_pct == r2.win_rate_pct

    # Per-fold exact match — guards against order-dependent aggregation.
    for a, b in zip(r1.fold_metrics, r2.fold_metrics, strict=True):
        assert asdict(a) == asdict(b)


def test_cpcv_splits_are_deterministic(zero_edge_bets):
    """Fold assignments must be bitwise identical across invocations."""
    df = zero_edge_bets
    cfg = CpcvConfig(n_groups=10, n_test_groups=2, embargo_pct=0.01)

    s1 = make_cpcv_splits(df, cfg)
    s2 = make_cpcv_splits(df, cfg)
    assert len(s1) == len(s2)
    for a, b in zip(s1, s2, strict=True):
        assert a.path_index == b.path_index
        assert np.array_equal(a.train_indices, b.train_indices)
        assert np.array_equal(a.test_indices, b.test_indices)


def test_bootstrap_is_deterministic_with_seed():
    """Bootstrap CI must be reproducible bit-for-bit given same seed."""
    values = np.array([0.5, -0.3, 1.2, -0.8, 2.1, -1.5, 0.9, 0.0, -0.2, 1.1])
    r1 = stationary_bootstrap_ci(values, seed=42, n_resamples=500)
    r2 = stationary_bootstrap_ci(values, seed=42, n_resamples=500)
    assert r1.mean == r2.mean
    assert r1.ci_low == r2.ci_low
    assert r1.ci_high == r2.ci_high


def test_pbo_is_deterministic_with_seed():
    """PBO score must be reproducible given the same fold matrix + seed."""
    rng = np.random.default_rng(123)
    # 20 trials × 10 folds. PBO expects list-of-lists, not an ndarray.
    fold_metrics = rng.normal(0.0, 1.0, size=(20, 10)).tolist()
    p1 = pbo_score(fold_metrics, seed=42)
    p2 = pbo_score(fold_metrics, seed=42)
    assert p1 == p2


def test_deflated_sharpe_is_deterministic():
    """Deflated Sharpe is pure math — same inputs must produce same output."""
    d1 = deflated_sharpe(
        1.8, n=500, n_trials=2000, sharpe_variance_across_trials=0.09
    )
    d2 = deflated_sharpe(
        1.8, n=500, n_trials=2000, sharpe_variance_across_trials=0.09
    )
    assert d1 == d2


def test_probabilistic_sharpe_is_deterministic():
    """PSR is pure math — same inputs must produce same output."""
    p1 = probabilistic_sharpe(1.3, n=600, benchmark_sharpe=0.0)
    p2 = probabilistic_sharpe(1.3, n=600, benchmark_sharpe=0.0)
    assert p1 == p2
