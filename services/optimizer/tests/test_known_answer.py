"""Known-answer test — end-to-end validation.

Gives the optimizer bets with a *known* +3% edge (P(win) = 1/odds + 0.03)
and asserts the evaluator finds a meaningfully positive OOS ROI on
almost every fold. If this test fails, something in the pipeline —
filtering, sizing, P&L math, CPCV fold assignment — is wrong enough
to miss a universal edge.

This is the true end-to-end sanity check. Placebo proves we don't
hallucinate edges; known-answer proves we find real ones.
"""

from __future__ import annotations

import numpy as np
from app.bootstrap import stationary_bootstrap_ci
from app.cpcv import CpcvConfig, make_cpcv_splits
from app.evaluator import evaluate_trial


def test_universal_edge_is_detected(positive_edge_bets, default_config):
    """+3% edge on every bet — the default config MUST show positive OOS ROI."""
    df = positive_edge_bets
    splits = make_cpcv_splits(df, CpcvConfig(n_groups=10, n_test_groups=2))
    result = evaluate_trial(df, splits, default_config)

    assert result.sample_size > 1_500, (
        f"expected ≥ 1500 bets to survive, got {result.sample_size}"
    )
    assert result.oos_roi_mean > 1.0, (
        f"known-answer FAILED — with +3% true edge on 2,000 bets, OOS ROI "
        f"mean is {result.oos_roi_mean:.3f}% (expected > 1.0%). The "
        "pipeline isn't detecting a universal edge."
    )


def test_universal_edge_ci_excludes_zero(positive_edge_bets, default_config):
    """Bootstrap CI on the per-fold ROIs must have ci_low > 0."""
    df = positive_edge_bets
    splits = make_cpcv_splits(df, CpcvConfig(n_groups=10, n_test_groups=2))
    result = evaluate_trial(df, splits, default_config)

    per_fold_rois = np.array(
        [f.roi_pct for f in result.fold_metrics if f.n_bets > 0]
    )
    assert per_fold_rois.size >= 10, "too few non-empty folds to bootstrap"

    ci = stationary_bootstrap_ci(per_fold_rois, seed=7, n_resamples=1000)
    assert ci.ci_low > 0.0, (
        f"known-answer FAILED — CI is [{ci.ci_low:.3f}, {ci.ci_high:.3f}] "
        "on universal +3% edge data; lower bound should be strictly > 0."
    )


def test_tighter_ev_cutoff_still_finds_edge(positive_edge_bets):
    """A stricter config (higher kelly, tighter odds) should still profit
    since the edge is universal — this is the 'optimizer convergence'
    smoke test."""
    df = positive_edge_bets
    splits = make_cpcv_splits(df, CpcvConfig(n_groups=10, n_test_groups=2))

    tight_cfg = {
        "min_ev_pct": 1.0,
        "odds_lo": 1.8,
        "odds_hi": 4.0,
        "staking_scheme": "kelly",
        "kelly_fraction": 0.30,
        "kelly_cap_pct": 5.0,
    }
    result = evaluate_trial(df, splits, tight_cfg)
    assert result.sample_size > 200, (
        f"tight config dropped too many rows: {result.sample_size}"
    )
    assert result.oos_roi_mean > 0.5, (
        f"tight config OOS ROI was {result.oos_roi_mean:.3f}% on universal "
        "+3% edge data — expected > 0.5%."
    )
