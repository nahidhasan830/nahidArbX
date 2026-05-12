"""Shared ML policy scoring helpers.

The runtime engine does not place every detected value bet once a model has
authority. It first turns the calibrated model probability into a model edge at
the offered odds:

    edge% = P(win) * adjusted_soft_odds - 1

Training, HPO, and deployment metrics must measure that same policy. If they
score every detected bet regardless of model output, a model can appear
profitable because the baseline detector is profitable, not because ML learned a
useful ranking.
"""

from __future__ import annotations

import math

import numpy as np

from .feature_names import FEATURE_NAMES

ADJUSTED_SOFT_ODDS_INDEX = FEATURE_NAMES.index("adjusted_soft_odds")
SOFT_ODDS_INDEX = FEATURE_NAMES.index("soft_odds")
EV_PCT_INDEX = FEATURE_NAMES.index("ev_pct")
MARKET_TYPE_INDEX = FEATURE_NAMES.index("market_type_encoded")

POLICY_EDGE_THRESHOLD_PCT = 0.0
MIN_POLICY_BETS_FOR_FULL_CREDIT = 30
NO_SELECTION_OBJECTIVE = -1.0

# Operator baseline used for incremental-profit checks. This mirrors the
# dashboard's "simple EV core" cohort: high-EV bets in the two most liquid
# football market families.
SIMPLE_RULE_MIN_EV_PCT = 3.0
SIMPLE_RULE_MARKET_TYPE_CODES = frozenset({0.0, 2.0})  # MATCH_RESULT, ASIAN_HANDICAP


def model_edge_pct(
    probs: np.ndarray,
    features: np.ndarray,
    *,
    threshold_odds: float = 1.01,
) -> np.ndarray:
    """Convert model probabilities into expected edge at offered odds."""
    adjusted_odds = features[:, ADJUSTED_SOFT_ODDS_INDEX].astype(np.float64)
    fallback_odds = features[:, SOFT_ODDS_INDEX].astype(np.float64)
    odds = np.where(adjusted_odds > threshold_odds, adjusted_odds, fallback_odds)
    odds = np.where(odds > threshold_odds, odds, np.nan)

    edge = (probs.astype(np.float64) * odds - 1.0) * 100.0
    return np.nan_to_num(edge, nan=-100.0, posinf=-100.0, neginf=-100.0)


def policy_mask(
    probs: np.ndarray,
    features: np.ndarray,
    *,
    edge_threshold_pct: float = POLICY_EDGE_THRESHOLD_PCT,
) -> np.ndarray:
    """Return rows the ML policy would keep."""
    return model_edge_pct(probs, features) > edge_threshold_pct


def policy_unit_returns(
    probs: np.ndarray,
    features: np.ndarray,
    unit_returns: np.ndarray,
    *,
    edge_threshold_pct: float = POLICY_EDGE_THRESHOLD_PCT,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return selected unit returns, all edge scores, and selected mask."""
    edges = model_edge_pct(probs, features)
    mask = edges > edge_threshold_pct
    clean_returns = np.nan_to_num(unit_returns.astype(np.float64), nan=0.0)
    return clean_returns[mask], edges, mask


def simple_rule_mask(features: np.ndarray) -> np.ndarray:
    """Rows selected by the non-ML baseline rule used for comparison."""
    ev_pct = features[:, EV_PCT_INDEX].astype(np.float64)
    market_type = features[:, MARKET_TYPE_INDEX].astype(np.float64)
    market_ok = np.isin(market_type, list(SIMPLE_RULE_MARKET_TYPE_CODES))
    return (ev_pct >= SIMPLE_RULE_MIN_EV_PCT) & market_ok


def simple_rule_unit_returns(
    features: np.ndarray,
    unit_returns: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Return selected unit returns and the selected mask for the baseline."""
    mask = simple_rule_mask(features)
    clean_returns = np.nan_to_num(unit_returns.astype(np.float64), nan=0.0)
    return clean_returns[mask], mask


def return_sharpe(unit_returns: np.ndarray) -> float:
    """Fold-level Sharpe-like score for unit returns."""
    if unit_returns.size <= 1:
        return 0.0
    std = float(unit_returns.std())
    if std <= 1e-12:
        return 0.0
    return float(unit_returns.mean() / std * math.sqrt(unit_returns.size))


def hpo_policy_objective_stats(
    probs: np.ndarray,
    features: np.ndarray,
    unit_returns: np.ndarray,
) -> tuple[float, float, int]:
    """Policy return metric for HPO.

    Returns (sample-adjusted mean unit return, sample-adjusted Sharpe, selected_n).
    The sample adjustment keeps tiny, lucky policy slices from dominating the
    search while still nudging Optuna toward configurations that find bets.
    """
    selected_returns, _, _ = policy_unit_returns(probs, features, unit_returns)
    selected_n = int(selected_returns.size)
    if selected_n == 0:
        return NO_SELECTION_OBJECTIVE, 0.0, 0

    credit = min(1.0, selected_n / MIN_POLICY_BETS_FOR_FULL_CREDIT)
    mean_unit_return = float(selected_returns.mean()) * credit
    sharpe = return_sharpe(selected_returns) * credit
    return mean_unit_return, sharpe, selected_n
