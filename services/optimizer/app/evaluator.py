"""Per-trial evaluation — pure function from (config, data, splits) to metrics.

For a sampled config:
 1. Apply filters → keep only matching rows
 2. Compute simulated stake per surviving row using the chosen sizing scheme
 3. Compute simulated P&L using the actual outcome (already in the row)
 4. Aggregate ROI / Sortino / Sharpe / max-drawdown / win-rate / sample size

This is the hot loop. Everything is Polars-native + vectorized; expect
~thousands of trials/sec on a single core for a ~1k-row DataFrame.

Sizing schemes match the conceptual model in lib/db/repositories/bets.ts —
they MUST stay consistent with the Next.js side. See
`tests/test_pnl_parity.py` for the snapshot pin.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
import polars as pl

from .cpcv import CpcvSplit


@dataclass(frozen=True)
class FoldMetrics:
    """Metrics for one OOS path."""

    path_index: int
    n_bets: int
    roi_pct: float
    win_rate_pct: float
    sharpe: float
    sortino: float
    max_drawdown: float
    total_stake: float
    total_pnl: float
    mean_clv_pct: float | None


@dataclass(frozen=True)
class TrialResult:
    """Aggregated across all OOS paths."""

    fold_metrics: list[FoldMetrics]
    sample_size: int
    oos_roi_mean: float
    oos_sharpe: float
    oos_sortino: float
    max_drawdown: float
    win_rate_pct: float


# ── Filtering ──────────────────────────────────────────────────────────────


def _apply_filters(df: pl.DataFrame, config: dict[str, Any]) -> pl.DataFrame:
    """Apply config filters to the DataFrame. Returns a possibly-empty subset."""
    expr = pl.lit(True)

    # EV gate.
    if (v := config.get("min_ev_pct")) is not None:
        expr = expr & (pl.col("ev_pct") >= v)

    # Staleness gate (only applied to rows that have an age recorded).
    if (v := config.get("max_odds_age_sec")) is not None:
        max_ms = float(v) * 1000.0
        expr = expr & (
            pl.col("sharp_odds_age_ms").is_null() | (pl.col("sharp_odds_age_ms") <= max_ms)
        )

    # Sharp-probability filter.
    if (v := config.get("min_sharp_prob")) is not None:
        expr = expr & (pl.col("sharp_true_prob") >= v)

    # Odds range filter.
    lo = config.get("odds_lo")
    hi = config.get("odds_hi")
    if lo is not None:
        expr = expr & (pl.col("soft_odds") >= lo)
    if hi is not None and (lo is None or hi > lo):
        expr = expr & (pl.col("soft_odds") <= hi)

    # Re-tick threshold.
    if (v := config.get("min_tick_count")) is not None:
        expr = expr & (pl.col("tick_count") >= v)

    # Pre-match only.
    if config.get("pre_match_only") is True:
        expr = expr & (pl.col("time_scope") == "pre_match")

    # Subset filters.
    softs = config.get("soft_providers")
    if softs:
        expr = expr & pl.col("soft_provider").is_in(list(softs))

    markets = config.get("market_types")
    if markets:
        expr = expr & pl.col("market_type").is_in(list(markets))

    return df.filter(expr)


# ── Sizing ─────────────────────────────────────────────────────────────────


def _compute_stakes(df: pl.DataFrame, config: dict[str, Any]) -> pl.Series:
    """Returns per-row simulated stake (in normalized units; ROI is unitless)."""
    scheme = config.get("staking_scheme", "kelly")
    kelly_fraction = float(config.get("kelly_fraction", 0.25))
    kelly_cap_pct = float(config.get("kelly_cap_pct", 10.0)) / 100.0  # fraction of bankroll
    bankroll = 1.0  # normalized — ROI is dimensionless

    if scheme == "flat":
        return pl.Series("stake", np.full(df.height, kelly_cap_pct * bankroll))

    # Kelly variants: full kelly per row.
    # Effective odds = soft_odds × (1 - commission/100), b = effective_odds - 1
    eff_odds = (df["soft_odds"] * (1.0 - df["soft_commission_pct"] / 100.0)).to_numpy()
    p = df["sharp_true_prob"].to_numpy()
    q = 1.0 - p
    b = np.where(eff_odds > 1.0, eff_odds - 1.0, 0.0)

    with np.errstate(divide="ignore", invalid="ignore"):
        full_kelly = np.where(b > 0, (b * p - q) / b, 0.0)
    full_kelly = np.clip(full_kelly, 0.0, 1.0)

    if scheme == "kelly":
        sized = full_kelly * kelly_fraction
    elif scheme == "sqrt_kelly":
        sized = np.sqrt(np.maximum(full_kelly, 0.0)) * kelly_fraction
    elif scheme == "log_utility":
        # Approximation: log-utility ≈ full-Kelly stake with risk aversion.
        sized = full_kelly * kelly_fraction * 0.8
    else:
        sized = full_kelly * kelly_fraction

    capped = np.minimum(sized, kelly_cap_pct) * bankroll
    return pl.Series("stake", capped)


# ── P&L mathematics — must match TS `computePnl()` exactly ────────────────


def _compute_pnl(
    stake: np.ndarray, odds: np.ndarray, commission_pct: np.ndarray, outcome: np.ndarray
) -> np.ndarray:
    """Vectorized P&L. `outcome` is a Utf8 numpy array."""
    won = outcome == "won"
    half_won = outcome == "half_won"
    lost = outcome == "lost"
    half_lost = outcome == "half_lost"
    # void / cancelled / pending → 0

    cf = 1.0 - (commission_pct / 100.0)
    payout_won = stake * (odds - 1.0) * cf
    payout_half_won = stake * (odds - 1.0) * cf / 2.0

    pnl = np.zeros_like(stake, dtype=np.float64)
    pnl = np.where(won, payout_won, pnl)
    pnl = np.where(half_won, payout_half_won, pnl)
    pnl = np.where(lost, -stake, pnl)
    pnl = np.where(half_lost, -stake / 2.0, pnl)
    return pnl


# ── Aggregation per fold ──────────────────────────────────────────────────


def _evaluate_fold(test_df: pl.DataFrame, config: dict[str, Any]) -> FoldMetrics:
    filtered = _apply_filters(test_df, config)
    n = filtered.height
    if n == 0:
        return FoldMetrics(
            path_index=-1, n_bets=0, roi_pct=0.0, win_rate_pct=0.0,
            sharpe=0.0, sortino=0.0, max_drawdown=0.0,
            total_stake=0.0, total_pnl=0.0, mean_clv_pct=None,
        )

    stake_s = _compute_stakes(filtered, config)
    stakes = stake_s.to_numpy()
    odds = filtered["soft_odds"].to_numpy()  # Use soft_odds — what we'd actually book at.
    commission = filtered["soft_commission_pct"].to_numpy()
    outcomes = filtered["outcome"].to_numpy()

    pnls = _compute_pnl(stakes, odds, commission, outcomes)
    total_stake = float(stakes.sum())
    total_pnl = float(pnls.sum())
    roi_pct = (total_pnl / total_stake * 100.0) if total_stake > 0 else 0.0

    # Win rate matches TS computeFlatMetrics (includes void in denom, half_won=0.5).
    settled_count = outcomes.size
    wins_full = np.sum(outcomes == "won")
    wins_half = np.sum(outcomes == "half_won")
    win_rate_pct = (
        (float(wins_full + wins_half * 0.5) / settled_count * 100.0)
        if settled_count > 0 else 0.0
    )

    # Sharpe / Sortino / max-drawdown on per-bet returns (pnl / stake when staked).
    with np.errstate(divide="ignore", invalid="ignore"):
        per_bet_returns = np.where(stakes > 0, pnls / stakes, 0.0)
    if per_bet_returns.size > 1:
        mu = float(per_bet_returns.mean())
        sd = float(per_bet_returns.std(ddof=1))
        sharpe = (mu / sd * math.sqrt(per_bet_returns.size)) if sd > 0 else 0.0
        downside = per_bet_returns[per_bet_returns < 0]
        dsd = float(downside.std(ddof=1)) if downside.size > 1 else 0.0
        sortino = (mu / dsd * math.sqrt(per_bet_returns.size)) if dsd > 0 else 0.0
    else:
        sharpe = sortino = 0.0

    # Max drawdown on cumulative pnl.
    cum = np.cumsum(pnls)
    peak = np.maximum.accumulate(cum)
    drawdowns = peak - cum
    max_dd = float(drawdowns.max()) if drawdowns.size else 0.0

    # Mean CLV (only over rows that have it).
    clv = filtered["clv_pct"].drop_nulls().to_numpy()
    mean_clv = float(clv.mean()) if clv.size > 0 else None

    return FoldMetrics(
        path_index=-1,  # set by caller
        n_bets=n,
        roi_pct=roi_pct,
        win_rate_pct=win_rate_pct,
        sharpe=sharpe,
        sortino=sortino,
        max_drawdown=max_dd,
        total_stake=total_stake,
        total_pnl=total_pnl,
        mean_clv_pct=mean_clv,
    )


# ── Trial-level aggregation across folds ─────────────────────────────────


def evaluate_trial(
    df: pl.DataFrame,
    splits: list[CpcvSplit],
    config: dict[str, Any],
) -> TrialResult:
    """Evaluate one config across every OOS path. Returns aggregated metrics."""
    fold_metrics: list[FoldMetrics] = []
    for split in splits:
        test_df = df[split.test_indices]
        fm = _evaluate_fold(test_df, config)
        # Replace path_index (frozen dataclass — can't mutate; rebuild).
        fold_metrics.append(
            FoldMetrics(
                path_index=split.path_index,
                n_bets=fm.n_bets,
                roi_pct=fm.roi_pct,
                win_rate_pct=fm.win_rate_pct,
                sharpe=fm.sharpe,
                sortino=fm.sortino,
                max_drawdown=fm.max_drawdown,
                total_stake=fm.total_stake,
                total_pnl=fm.total_pnl,
                mean_clv_pct=fm.mean_clv_pct,
            )
        )

    if not fold_metrics:
        return TrialResult(
            fold_metrics=[], sample_size=0,
            oos_roi_mean=0.0, oos_sharpe=0.0, oos_sortino=0.0,
            max_drawdown=0.0, win_rate_pct=0.0,
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
