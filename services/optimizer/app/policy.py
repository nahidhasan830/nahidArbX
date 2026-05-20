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
from dataclasses import dataclass

import numpy as np

from .feature_names import FEATURE_NAMES

ADJUSTED_SOFT_ODDS_INDEX = FEATURE_NAMES.index("adjusted_soft_odds")
SOFT_ODDS_INDEX = FEATURE_NAMES.index("soft_odds")
EV_PCT_INDEX = FEATURE_NAMES.index("ev_pct")
MARKET_TYPE_INDEX = FEATURE_NAMES.index("market_type_encoded")

POLICY_EDGE_THRESHOLD_PCT = 0.0
POLICY_EDGE_THRESHOLD_CANDIDATES_PCT = (0.0, 2.0, 5.0, 8.0, 10.0, 15.0, 20.0)
MIN_POLICY_BETS_FOR_FULL_CREDIT = 30
MIN_POLICY_BETS_FOR_THRESHOLD = 100
NO_SELECTION_OBJECTIVE = -1.0

# Operator baseline used for incremental-profit checks. This mirrors the
# dashboard's "simple EV core" cohort: high-EV bets in the two most liquid
# football market families.
SIMPLE_RULE_MIN_EV_PCT = 3.0
SIMPLE_RULE_MARKET_TYPE_CODES = frozenset({0.0, 2.0})  # MATCH_RESULT, ASIAN_HANDICAP


@dataclass(frozen=True)
class PolicyThresholdResult:
    """Selected model-edge threshold for the ML overlay policy."""

    threshold_pct: float
    roi_pct: float
    sample_size: int
    coverage: float
    sharpe: float
    simple_roi_pct: float
    simple_sample_size: int
    roi_delta_pct: float
    lower_confidence_roi_pct: float
    candidates_evaluated: int


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
    """Return rows the ML overlay policy would keep.

    The deterministic simple EV rule is the primary strategy. ML acts as a
    meta-label/filter on top of that primary strategy, which is the standard
    way to ask whether the model adds incremental edge instead of merely
    inheriting the detector's baseline profitability.
    """
    return simple_rule_mask(features) & (model_edge_pct(probs, features) > edge_threshold_pct)


def policy_unit_returns(
    probs: np.ndarray,
    features: np.ndarray,
    unit_returns: np.ndarray,
    *,
    edge_threshold_pct: float = POLICY_EDGE_THRESHOLD_PCT,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return selected unit returns, all edge scores, and selected mask."""
    edges = model_edge_pct(probs, features)
    mask = simple_rule_mask(features) & (edges > edge_threshold_pct)
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


def select_policy_threshold(
    probs: np.ndarray,
    features: np.ndarray,
    unit_returns: np.ndarray,
    *,
    candidates: tuple[float, ...] = POLICY_EDGE_THRESHOLD_CANDIDATES_PCT,
    min_sample_size: int = MIN_POLICY_BETS_FOR_THRESHOLD,
) -> PolicyThresholdResult:
    """Select a conservative model-edge threshold on CPCV/OOS predictions.

    Score each threshold by a one-sided 90% lower confidence bound of
    incremental ROI versus the simple EV baseline. This avoids picking a
    high-ROI threshold that only won because it kept a tiny, lucky slice.
    """
    clean_returns = np.nan_to_num(unit_returns.astype(np.float64), nan=0.0)
    simple_returns, simple_mask = simple_rule_unit_returns(features, clean_returns)
    simple_n = int(simple_mask.sum())
    simple_roi = float(simple_returns.mean() * 100.0) if simple_n > 0 else 0.0
    if simple_n > 1:
        simple_se_pct = float(simple_returns.std(ddof=1) / math.sqrt(simple_n) * 100.0)
    else:
        simple_se_pct = 0.0

    best: PolicyThresholdResult | None = None
    fallback: PolicyThresholdResult | None = None

    for threshold in candidates:
        selected, _edges, mask = policy_unit_returns(
            probs,
            features,
            clean_returns,
            edge_threshold_pct=threshold,
        )
        n = int(selected.size)
        roi = float(selected.mean() * 100.0) if n > 0 else 0.0
        coverage = float(n / len(clean_returns)) if clean_returns.size > 0 else 0.0
        sharpe = return_sharpe(selected)
        if n > 1:
            se_pct = float(selected.std(ddof=1) / math.sqrt(n) * 100.0)
        else:
            se_pct = float("inf")
        delta = roi - simple_roi
        delta_se_pct = math.sqrt(se_pct**2 + simple_se_pct**2)
        lower = delta - 1.2815515655446004 * delta_se_pct  # 90% one-sided normal z
        result = PolicyThresholdResult(
            threshold_pct=float(threshold),
            roi_pct=roi,
            sample_size=n,
            coverage=coverage,
            sharpe=sharpe,
            simple_roi_pct=simple_roi,
            simple_sample_size=simple_n,
            roi_delta_pct=delta,
            lower_confidence_roi_pct=lower,
            candidates_evaluated=len(candidates),
        )

        if (
            fallback is None
            or result.sample_size > fallback.sample_size
            or (
                result.sample_size == fallback.sample_size
                and result.lower_confidence_roi_pct > fallback.lower_confidence_roi_pct
            )
        ):
            fallback = result

        if n < min_sample_size:
            continue
        if (
            best is None
            or result.lower_confidence_roi_pct > best.lower_confidence_roi_pct
            or (
                result.lower_confidence_roi_pct == best.lower_confidence_roi_pct
                and result.sample_size > best.sample_size
            )
        ):
            best = result

    if best is not None:
        return best
    if fallback is not None:
        return fallback
    return PolicyThresholdResult(
        threshold_pct=POLICY_EDGE_THRESHOLD_PCT,
        roi_pct=0.0,
        sample_size=0,
        coverage=0.0,
        sharpe=0.0,
        simple_roi_pct=simple_roi,
        simple_sample_size=simple_n,
        roi_delta_pct=-simple_roi,
        lower_confidence_roi_pct=float("-inf"),
        candidates_evaluated=0,
    )


def return_sharpe(unit_returns: np.ndarray) -> float:
    """Fold-level Sharpe-like score for unit returns.

    When the policy gate selects very few bets (e.g. after a label-distribution
    shift), a single-bet fold or a degenerate-zero-std fold would previously
    return 0.0 and collapse the cross-fold CPCV mean.  With a single bet we
    can still report its directional unit return so the mean across folds
    remains informative.
    """
    if unit_returns.size == 0:
        return 0.0
    if unit_returns.size == 1:
        return float(unit_returns[0])
    std = float(unit_returns.std(ddof=0))
    if std <= 1e-12:
        return float(unit_returns.mean())
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
