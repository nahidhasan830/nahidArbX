"""Placebo test — the #1 correctness gate.

Takes bets with zero true edge (P(win) = 1/odds exactly) and runs many
evaluator configs. Every config's OOS ROI 95% CI should straddle zero:
if ANY config reports a confident positive edge on zero-edge data, the
statistical layer is leaking somewhere (look-ahead, embargo math,
bootstrap seed, CPCV fold assignment, …).

This is the single most valuable test in the suite — it catches
look-ahead leakage, overfit-penalty bugs, and Pareto bugs all at once.
"""

from __future__ import annotations

import numpy as np
from app.bootstrap import stationary_bootstrap_ci
from app.cpcv import CpcvConfig, make_cpcv_splits
from app.evaluator import evaluate_trial


_CONFIGS_TO_SWEEP = [
    # Narrow configs — small sample, high variance. The CI should be
    # wide enough to include zero.
    {"min_ev_pct": 3.0, "odds_lo": 1.5, "odds_hi": 3.0, "kelly_fraction": 0.25},
    {"min_ev_pct": 4.0, "odds_lo": 2.0, "odds_hi": 4.0, "kelly_fraction": 0.25},
    # Wide configs — bigger sample, tighter CI.
    {"min_ev_pct": 0.0, "odds_lo": 1.5, "odds_hi": 5.0, "kelly_fraction": 0.25},
    {"min_ev_pct": 0.5, "odds_lo": 1.5, "odds_hi": 5.0, "kelly_fraction": 0.10},
    # Per-market slices.
    {
        "min_ev_pct": 0.0,
        "odds_lo": 1.5,
        "odds_hi": 5.0,
        "kelly_fraction": 0.25,
        "market_types": ["MATCH_ODDS"],
    },
    {
        "min_ev_pct": 0.0,
        "odds_lo": 1.5,
        "odds_hi": 5.0,
        "kelly_fraction": 0.25,
        "market_types": ["ASIAN_HANDICAP"],
    },
    # Flat staking — shouldn't matter for zero-edge but confirms scheme
    # independence.
    {
        "min_ev_pct": 0.0,
        "odds_lo": 1.5,
        "odds_hi": 5.0,
        "staking_scheme": "flat",
        "kelly_cap_pct": 2.0,
    },
]


def test_placebo_no_config_beats_zero(zero_edge_bets):
    """On zero-edge data, no config's OOS ROI CI should have lower bound > 0."""
    df = zero_edge_bets
    splits = make_cpcv_splits(df, CpcvConfig(n_groups=10, n_test_groups=2))

    positive_ci_configs = []
    for i, cfg in enumerate(_CONFIGS_TO_SWEEP):
        full_cfg = {
            "min_ev_pct": 0.0,
            "staking_scheme": "kelly",
            "kelly_fraction": 0.25,
            "kelly_cap_pct": 5.0,
            **cfg,
        }
        result = evaluate_trial(df, splits, full_cfg)
        if result.sample_size < 50:
            # Too few bets to judge — the low-confidence gate would flag
            # this in production. Skip.
            continue

        per_fold_rois = np.array(
            [f.roi_pct for f in result.fold_metrics if f.n_bets > 0]
        )
        if per_fold_rois.size < 2:
            continue

        ci = stationary_bootstrap_ci(per_fold_rois, seed=17 + i, n_resamples=1000)
        # The key assertion — a CI whose low bound is > 0 on zero-edge
        # data means the statistical layer is leaking.
        if ci.ci_low > 0.0:
            positive_ci_configs.append(
                {
                    "cfg": cfg,
                    "roi_mean": result.oos_roi_mean,
                    "ci_low": ci.ci_low,
                    "ci_high": ci.ci_high,
                    "sample_size": result.sample_size,
                }
            )

    assert not positive_ci_configs, (
        "Placebo FAILED — on zero-edge data, these configs reported a "
        "confident positive OOS ROI (CI lower bound > 0). This indicates "
        f"leakage in the evaluator or bootstrap.\nOffenders: {positive_ci_configs}"
    )


def test_placebo_mean_roi_centered_on_zero(zero_edge_bets):
    """Sanity check — aggregated across configs, the mean OOS ROI should
    be near zero. A systematic bias would indicate the P&L computation
    or sizing has a consistent direction."""
    df = zero_edge_bets
    splits = make_cpcv_splits(df, CpcvConfig(n_groups=10, n_test_groups=2))

    all_rois: list[float] = []
    for cfg in _CONFIGS_TO_SWEEP:
        full_cfg = {
            "min_ev_pct": 0.0,
            "staking_scheme": "kelly",
            "kelly_fraction": 0.25,
            "kelly_cap_pct": 5.0,
            **cfg,
        }
        result = evaluate_trial(df, splits, full_cfg)
        if result.sample_size >= 50:
            all_rois.append(result.oos_roi_mean)

    assert len(all_rois) >= 3, "too few configs survived — fixture may be off"
    mean_roi = float(np.mean(all_rois))
    assert abs(mean_roi) < 2.0, (
        f"Aggregate mean OOS ROI on zero-edge data is {mean_roi:.3f}% — "
        "expected |mean| < 2.0%. Systematic bias suggests a P&L or sizing "
        "bug."
    )
