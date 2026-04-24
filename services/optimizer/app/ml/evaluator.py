"""ML trial evaluator — train on CPCV train fold, evaluate on test fold.

Returns the same `TrialResult` shape as the rule-based evaluator so all
downstream machinery (PBO, WRC, Pareto, DSR/PSR, bootstrap CIs, persistence)
works uniformly across rule-based AND ML configurations.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import polars as pl

from ..cpcv import CpcvSplit
from ..evaluator import FoldMetrics, TrialResult, _compute_pnl
from .features import build_feature_matrix, make_label
from .model import MlConfig, train_and_predict


def _evaluate_ml_fold(
    train_df: pl.DataFrame,
    test_df: pl.DataFrame,
    cfg: MlConfig,
    sizing_kelly_fraction: float,
    sizing_kelly_cap_pct: float,
    path_index: int,
) -> FoldMetrics:
    if train_df.height < 50 or test_df.height == 0:
        return FoldMetrics(
            path_index=path_index,
            n_bets=0,
            roi_pct=0.0,
            win_rate_pct=0.0,
            sharpe=0.0,
            sortino=0.0,
            max_drawdown=0.0,
            total_stake=0.0,
            total_pnl=0.0,
            mean_clv_pct=None,
        )

    X_train, X_test, _ = build_feature_matrix(train_df, test_df)
    y_train = make_label(train_df)
    proba = train_and_predict(X_train, y_train, X_test, cfg)

    take_mask = proba >= cfg.threshold
    if not take_mask.any():
        return FoldMetrics(
            path_index=path_index,
            n_bets=0,
            roi_pct=0.0,
            win_rate_pct=0.0,
            sharpe=0.0,
            sortino=0.0,
            max_drawdown=0.0,
            total_stake=0.0,
            total_pnl=0.0,
            mean_clv_pct=None,
        )

    # Slice the test frame to the bets the model would have taken.
    take_idx = np.where(take_mask)[0]
    selected = test_df[take_idx]
    eff_odds = (
        selected["soft_odds"].to_numpy()
        * (1.0 - selected["soft_commission_pct"].to_numpy() / 100.0)
    )
    p_taken = proba[take_idx]
    q_taken = 1.0 - p_taken

    # Kelly with the model's calibrated probability — capped by sizing config.
    bankroll = 1.0  # normalized
    b = np.where(eff_odds > 1.0, eff_odds - 1.0, 0.0)
    with np.errstate(divide="ignore", invalid="ignore"):
        full_kelly = np.where(b > 0, (b * p_taken - q_taken) / b, 0.0)
    full_kelly = np.clip(full_kelly, 0.0, 1.0)
    sized = full_kelly * sizing_kelly_fraction
    capped = np.minimum(sized, sizing_kelly_cap_pct / 100.0) * bankroll

    odds = selected["soft_odds"].to_numpy()
    outcomes = selected["outcome"].to_numpy()
    pnls = _compute_pnl(capped, odds, outcomes)

    total_stake = float(capped.sum())
    total_pnl = float(pnls.sum())
    roi_pct = (total_pnl / total_stake * 100.0) if total_stake > 0 else 0.0

    decisive = np.isin(outcomes, ["won", "half_won", "lost", "half_lost"])
    wins = np.isin(outcomes, ["won", "half_won"])
    decisive_count = int(decisive.sum())
    win_rate_pct = (
        (float(wins.sum()) / decisive_count * 100.0) if decisive_count > 0 else 0.0
    )

    with np.errstate(divide="ignore", invalid="ignore"):
        per_bet_returns = np.where(capped > 0, pnls / capped, 0.0)
    if per_bet_returns.size > 1:
        mu = float(per_bet_returns.mean())
        sd = float(per_bet_returns.std(ddof=1))
        sharpe = (mu / sd * math.sqrt(per_bet_returns.size)) if sd > 0 else 0.0
        downside = per_bet_returns[per_bet_returns < 0]
        dsd = float(downside.std(ddof=1)) if downside.size > 1 else 0.0
        sortino = (mu / dsd * math.sqrt(per_bet_returns.size)) if dsd > 0 else 0.0
    else:
        sharpe = sortino = 0.0

    cum = np.cumsum(pnls)
    peak = np.maximum.accumulate(cum)
    drawdowns = peak - cum
    max_dd = float(drawdowns.max()) if drawdowns.size else 0.0

    clv = selected["clv_pct"].drop_nulls().to_numpy()
    mean_clv = float(clv.mean()) if clv.size > 0 else None

    return FoldMetrics(
        path_index=path_index,
        n_bets=int(take_mask.sum()),
        roi_pct=roi_pct,
        win_rate_pct=win_rate_pct,
        sharpe=sharpe,
        sortino=sortino,
        max_drawdown=max_dd,
        total_stake=total_stake,
        total_pnl=total_pnl,
        mean_clv_pct=mean_clv,
    )


def evaluate_ml_trial(
    df: pl.DataFrame,
    splits: list[CpcvSplit],
    config: dict[str, Any],
) -> TrialResult:
    """ML version of evaluate_trial. The `config` dict is the Optuna sample.

    Sampled parameters (see `ml_search_space()` below):
      n_estimators, max_depth, learning_rate, subsample, colsample_bytree,
      min_child_weight, threshold, kelly_fraction, kelly_cap_pct
    """
    cfg = MlConfig(
        n_estimators=int(config.get("n_estimators", 200)),
        max_depth=int(config.get("max_depth", 4)),
        learning_rate=float(config.get("learning_rate", 0.1)),
        subsample=float(config.get("subsample", 0.9)),
        colsample_bytree=float(config.get("colsample_bytree", 0.9)),
        min_child_weight=int(config.get("min_child_weight", 5)),
        threshold=float(config.get("threshold", 0.55)),
    )
    sizing_kf = float(config.get("kelly_fraction", 0.25))
    sizing_cap = float(config.get("kelly_cap_pct", 10.0))

    fold_metrics: list[FoldMetrics] = []
    for split in splits:
        train_df = df[split.train_indices]
        test_df = df[split.test_indices]
        fm = _evaluate_ml_fold(
            train_df, test_df, cfg, sizing_kf, sizing_cap, split.path_index
        )
        fold_metrics.append(fm)

    if not fold_metrics:
        return TrialResult(
            fold_metrics=[],
            sample_size=0,
            oos_roi_mean=0.0,
            oos_sharpe=0.0,
            oos_sortino=0.0,
            max_drawdown=0.0,
            win_rate_pct=0.0,
        )

    rois = np.array([f.roi_pct for f in fold_metrics if f.n_bets > 0])
    sharpes = np.array([f.sharpe for f in fold_metrics if f.n_bets > 0])
    sortinos = np.array([f.sortino for f in fold_metrics if f.n_bets > 0])
    win_rates = np.array([f.win_rate_pct for f in fold_metrics if f.n_bets > 0])
    sample_size = int(sum(f.n_bets for f in fold_metrics))

    return TrialResult(
        fold_metrics=fold_metrics,
        sample_size=sample_size,
        oos_roi_mean=float(rois.mean()) if rois.size > 0 else 0.0,
        oos_sharpe=float(sharpes.mean()) if sharpes.size > 0 else 0.0,
        oos_sortino=float(sortinos.mean()) if sortinos.size > 0 else 0.0,
        max_drawdown=float(max(f.max_drawdown for f in fold_metrics)),
        win_rate_pct=float(win_rates.mean()) if win_rates.size > 0 else 0.0,
    )


def ml_search_space():
    """ML hyperparameter search space — used when the run row's
    `searchAlgorithm == 'ml-xgboost'` and `search_space.dimensions` is empty.
    """
    from ..search_space import Dimension, SearchSpace

    return SearchSpace(
        dimensions=(
            Dimension("n_estimators", "discrete", values=(100, 200, 400, 600)),
            Dimension("max_depth", "discrete", values=(3, 4, 5, 6, 8)),
            Dimension(
                "learning_rate",
                "continuous",
                low=0.02,
                high=0.20,
                step=0.02,
            ),
            Dimension(
                "subsample", "continuous", low=0.6, high=1.0, step=0.1,
            ),
            Dimension(
                "colsample_bytree", "continuous", low=0.6, high=1.0, step=0.1,
            ),
            Dimension(
                "min_child_weight", "discrete", values=(1, 5, 10, 20),
            ),
            Dimension("threshold", "continuous", low=0.45, high=0.75, step=0.025),
            Dimension("kelly_fraction", "continuous", low=0.10, high=0.50, step=0.05),
            Dimension("kelly_cap_pct", "continuous", low=2.0, high=15.0, step=1.0),
        )
    )
