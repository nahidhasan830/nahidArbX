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
import polars as pl

from .feature_names import FEATURE_NAMES

ADJUSTED_SOFT_ODDS_INDEX = FEATURE_NAMES.index("adjusted_soft_odds")
SOFT_ODDS_INDEX = FEATURE_NAMES.index("soft_odds")
SHARP_TRUE_PROB_INDEX = FEATURE_NAMES.index("sharp_true_prob")
MARKET_TYPE_INDEX = FEATURE_NAMES.index("market_type_encoded")

# Fixed 2% threshold matching MIN_EV_PCT from detector
POLICY_EDGE_THRESHOLD_PCT = 2.0
MIN_POLICY_BETS_FOR_FULL_CREDIT = 30
NO_SELECTION_OBJECTIVE = -1.0

# Operator baseline used for incremental-profit checks. This mirrors the
# dashboard's "simple EV core" cohort: high-EV bets in the two most liquid
# football market families.
SIMPLE_RULE_MIN_EV_PCT = 3.0
SIMPLE_RULE_MARKET_TYPE_CODES = frozenset({0.0, 2.0})  # MATCH_RESULT, ASIAN_HANDICAP


@dataclass(frozen=True)
class PolicyThresholdResult:
    """Fixed model-edge threshold for the ML overlay policy (no longer searched)."""

    threshold_pct: float
    roi_pct: float
    sample_size: int
    coverage: float
    sharpe: float
    simple_roi_pct: float
    simple_sample_size: int
    roi_delta_pct: float


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


def best_per_family_mask(
    mask: np.ndarray,
    edge_scores_pct: np.ndarray,
    metadata: pl.DataFrame | None = None,
) -> np.ndarray:
    """Keep at most one selected atom per event/family closed market.

    Betting rows are scored independently, but an event/family is a mutually
    exclusive market: e.g. over 2.5 and under 2.5 cannot both be good actions
    for the same event. When metadata has the market keys, choose the selected
    row with the highest model edge inside each event/family. Synthetic tests
    and older callers without those columns keep the original mask.
    """
    selected = np.asarray(mask, dtype=bool).copy()
    if metadata is None or selected.size == 0:
        return selected
    if "event_id" not in metadata.columns or "family_id" not in metadata.columns:
        return selected
    if len(metadata) != selected.size:
        return selected

    best_by_family: dict[tuple[str, str], int] = {}
    for i, is_selected in enumerate(selected):
        if not bool(is_selected):
            continue
        event_id = metadata["event_id"][i]
        family_id = metadata["family_id"][i]
        if event_id is None or family_id is None:
            continue
        key = (str(event_id), str(family_id))
        current = best_by_family.get(key)
        if current is None or _is_better_family_candidate(
            i,
            current,
            edge_scores_pct=edge_scores_pct,
            metadata=metadata,
        ):
            best_by_family[key] = i

    if not best_by_family:
        return selected

    out = np.zeros_like(selected, dtype=bool)
    for index in best_by_family.values():
        out[index] = True
    return out


def _is_better_family_candidate(
    candidate: int,
    incumbent: int,
    *,
    edge_scores_pct: np.ndarray,
    metadata: pl.DataFrame,
) -> bool:
    candidate_edge = float(edge_scores_pct[candidate])
    incumbent_edge = float(edge_scores_pct[incumbent])
    if candidate_edge != incumbent_edge:
        return candidate_edge > incumbent_edge

    for col in ("soft_odds", "sharp_true_prob"):
        if col not in metadata.columns:
            continue
        candidate_value = _numeric_metadata_value(metadata, col, candidate)
        incumbent_value = _numeric_metadata_value(metadata, col, incumbent)
        if candidate_value != incumbent_value:
            return candidate_value > incumbent_value

    if "id" in metadata.columns:
        return str(metadata["id"][candidate]) < str(metadata["id"][incumbent])
    return candidate < incumbent


def _numeric_metadata_value(metadata: pl.DataFrame, col: str, index: int) -> float:
    value = metadata[col][index]
    if value is None:
        return float("-inf")
    try:
        out = float(value)
    except (TypeError, ValueError):
        return float("-inf")
    return out if np.isfinite(out) else float("-inf")


def policy_unit_returns(
    probs: np.ndarray,
    features: np.ndarray,
    unit_returns: np.ndarray,
    *,
    edge_threshold_pct: float = POLICY_EDGE_THRESHOLD_PCT,
    metadata: pl.DataFrame | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return selected unit returns, all edge scores, and selected mask."""
    edges = model_edge_pct(probs, features)
    mask = simple_rule_mask(features) & (edges > edge_threshold_pct)
    mask = best_per_family_mask(mask, edges, metadata)
    clean_returns = np.nan_to_num(unit_returns.astype(np.float64), nan=0.0)
    return clean_returns[mask], edges, mask


def simple_rule_mask(features: np.ndarray) -> np.ndarray:
    """Rows selected by the non-ML baseline rule used for comparison.

    Computes EV% from features since it's no longer in the feature vector.
    EV% = (adjusted_soft_odds * sharp_true_prob - 1) * 100
    """
    market_type = features[:, MARKET_TYPE_INDEX].astype(np.float64)
    market_ok = np.isin(market_type, list(SIMPLE_RULE_MARKET_TYPE_CODES))
    return (simple_rule_edge_pct(features) >= SIMPLE_RULE_MIN_EV_PCT) & market_ok


def simple_rule_edge_pct(features: np.ndarray) -> np.ndarray:
    sharp_prob = features[:, SHARP_TRUE_PROB_INDEX].astype(np.float64)
    adjusted_odds = features[:, ADJUSTED_SOFT_ODDS_INDEX].astype(np.float64)
    return (adjusted_odds * sharp_prob - 1.0) * 100.0


def simple_rule_unit_returns(
    features: np.ndarray,
    unit_returns: np.ndarray,
    metadata: pl.DataFrame | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Return selected unit returns and the selected mask for the baseline."""
    mask = simple_rule_mask(features)
    mask = best_per_family_mask(mask, simple_rule_edge_pct(features), metadata)
    clean_returns = np.nan_to_num(unit_returns.astype(np.float64), nan=0.0)
    return clean_returns[mask], mask


def compute_policy_threshold_stats(
    probs: np.ndarray,
    features: np.ndarray,
    unit_returns: np.ndarray,
    metadata: pl.DataFrame | None = None,
) -> PolicyThresholdResult:
    """Compute stats for the fixed 2% policy threshold.

    Replaces select_policy_threshold — no longer searches multiple candidates.
    The model should learn to beat the baseline at a fixed threshold, not
    find the best threshold (which overfits to the validation set).
    """
    clean_returns = np.nan_to_num(unit_returns.astype(np.float64), nan=0.0)
    simple_returns, simple_mask = simple_rule_unit_returns(
        features,
        clean_returns,
        metadata=metadata,
    )
    simple_n = int(simple_mask.sum())
    simple_roi = float(simple_returns.mean() * 100.0) if simple_n > 0 else 0.0

    selected, _edges, _mask = policy_unit_returns(
        probs,
        features,
        clean_returns,
        edge_threshold_pct=POLICY_EDGE_THRESHOLD_PCT,
        metadata=metadata,
    )
    n = int(selected.size)
    roi = float(selected.mean() * 100.0) if n > 0 else 0.0
    coverage = float(n / len(clean_returns)) if clean_returns.size > 0 else 0.0
    sharpe = return_sharpe(selected)
    delta = roi - simple_roi

    return PolicyThresholdResult(
        threshold_pct=POLICY_EDGE_THRESHOLD_PCT,
        roi_pct=roi,
        sample_size=n,
        coverage=coverage,
        sharpe=sharpe,
        simple_roi_pct=simple_roi,
        simple_sample_size=simple_n,
        roi_delta_pct=delta,
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
    metadata: pl.DataFrame | None = None,
) -> tuple[float, float, int]:
    """Policy return metric for HPO.

    Returns (sample-adjusted mean unit return, sample-adjusted Sharpe, selected_n).
    The sample adjustment keeps tiny, lucky policy slices from dominating the
    search while still nudging Optuna toward configurations that find bets.
    """
    selected_returns, _, _ = policy_unit_returns(
        probs,
        features,
        unit_returns,
        metadata=metadata,
    )
    selected_n = int(selected_returns.size)
    if selected_n == 0:
        return NO_SELECTION_OBJECTIVE, 0.0, 0

    credit = min(1.0, selected_n / MIN_POLICY_BETS_FOR_FULL_CREDIT)
    mean_unit_return = float(selected_returns.mean()) * credit
    sharpe = return_sharpe(selected_returns) * credit
    return mean_unit_return, sharpe, selected_n
