"""Shared fixtures for ML pipeline correctness tests.

Generates synthetic training data with known signal characteristics
so we can verify the full LightGBM → ONNX pipeline produces correct
outputs without touching Postgres.
"""

from __future__ import annotations

import numpy as np
import polars as pl
import pytest

from app.feature_names import FEATURE_COUNT, FEATURE_NAMES
from app.loader import TrainingData


def make_synthetic_training_data(
    n: int = 1_000,
    *,
    true_edge: float = 0.03,
    seed: int = 42,
) -> TrainingData:
    """Generate synthetic training data with known signal.

    ``true_edge`` controls how much the positive class is inflated:
    features that matter (ev_pct, sharp_true_prob, etc.) will have
    a detectable signal that LightGBM should learn.

    Returns a TrainingData container matching the real loader's output.
    """
    rng = np.random.default_rng(seed)

    # Generate realistic feature values
    features = np.zeros((n, FEATURE_COUNT), dtype=np.float32)

    idx = {name: FEATURE_NAMES.index(name) for name in FEATURE_NAMES}

    features[:, idx["sharp_true_prob"]] = rng.uniform(0.15, 0.85, size=n)
    features[:, idx["soft_odds"]] = rng.uniform(1.3, 6.0, size=n)
    features[:, idx["adjusted_soft_odds"]] = (
        features[:, idx["soft_odds"]] * rng.uniform(0.97, 1.0, size=n)
    )
    features[:, idx["tick_count"]] = rng.integers(1, 50, size=n).astype(np.float32)
    features[:, idx["time_to_kickoff_min"]] = rng.uniform(5, 600, size=n)
    features[:, idx["movement_pct_sharp"]] = rng.normal(0, 1.5, size=n)
    features[:, idx["movement_pct_soft"]] = rng.normal(0, 2.0, size=n)
    features[:, idx["steam_move_sharp"]] = (rng.random(n) < 0.1).astype(np.float32)
    features[:, idx["steam_move_soft"]] = (rng.random(n) < 0.15).astype(np.float32)
    features[:, idx["sharp_direction"]] = rng.choice([-1, 0, 1], size=n).astype(np.float32)
    features[:, idx["soft_direction"]] = rng.choice([-1, 0, 1], size=n).astype(np.float32)
    features[:, idx["convergence_rate"]] = rng.normal(-0.5, 1.0, size=n)
    features[:, idx["tick_velocity"]] = rng.exponential(2.0, size=n)
    features[:, idx["provider_count"]] = rng.choice([2, 3, 4], size=n).astype(np.float32)
    features[:, idx["opening_sharp_odds"]] = (
        features[:, idx["soft_odds"]] + rng.normal(0, 0.2, size=n)
    )
    features[:, idx["market_type_encoded"]] = rng.integers(0, 8, size=n).astype(np.float32)
    features[:, idx["is_asian_line"]] = (rng.random(n) < 0.3).astype(np.float32)
    features[:, idx["vig_pct"]] = rng.uniform(2.0, 8.0, size=n)
    features[:, idx["competition_tier"]] = rng.choice([1, 2, 3], size=n).astype(np.float32)
    features[:, idx["hours_since_line_opened"]] = rng.uniform(0, 48, size=n)
    features[:, idx["sharp_soft_spread"]] = rng.normal(0, 0.5, size=n)
    features[:, idx["num_markets_same_event"]] = rng.choice([1, 2, 3, 4, 5], size=n).astype(np.float32)

    # Generate labels with a signal correlated to ev_pct + sharp_true_prob
    # Higher EV and higher sharp_true_prob → more likely to win
    signal = (
        features[:, idx["sharp_true_prob"]] * 0.5
        + features[:, idx["tick_count"]] * 0.01
        + true_edge
    )
    win_prob = 1.0 / (1.0 + np.exp(-signal + 0.5))  # sigmoid
    labels = (rng.random(n) < win_prob).astype(np.int32)

    # Build metadata DataFrame
    soft_odds = features[:, idx["soft_odds"]].astype(np.float64)
    pnl = np.where(labels == 1, soft_odds - 1.0, -1.0)

    base_ts = 1735689600  # 2025-01-01 UTC
    timestamps = base_ts + np.sort(rng.integers(0, 180 * 86400, size=n))

    metadata = pl.DataFrame({
        "id": [f"synthetic-{i}" for i in range(n)],
        "outcome": ["won" if l == 1 else "lost" for l in labels],
        "pnl": pnl.tolist(),
        "soft_odds": soft_odds.tolist(),
        "sharp_true_prob": features[:, idx["sharp_true_prob"]].astype(np.float64).tolist(),
        "soft_commission_pct": rng.choice([0.0, 2.0, 5.0], size=n).astype(np.float64).tolist(),
        "closing_sharp_odds": (soft_odds + rng.normal(0, 0.1, size=n)).tolist(),
        "clv_pct": rng.normal(1.0, 3.0, size=n).tolist(),
        "first_seen_at": [str(t) for t in timestamps],
        "event_start_time": [str(t + 3600) for t in timestamps],
        "event_id": [f"event-{i // 3}" for i in range(n)],
    })

    # Derive sample weights — simulate realistic weight distribution
    # Half outcomes don't exist in synthetic data, so all base weights are 1.0.
    # Apply PnL boost to match the real loader's logic.
    pnl_values = pnl.astype(np.float64)
    sample_weights = np.ones(n, dtype=np.float64)
    for i in range(n):
        pnl_abs = abs(pnl_values[i])
        if pnl_abs > 0:
            boost = 1.0 + np.log1p(pnl_abs / 5.0) * 0.3
            sample_weights[i] = min(boost, 2.0)

    n_pos = int(labels.sum())
    n_neg = int((labels == 0).sum())
    ratio = n_neg / n_pos if n_pos > 0 else 1.0
    scale_pos_weight = 1.0 if 0.7 <= ratio <= 1.4 else round(np.sqrt(ratio), 4)

    return TrainingData(
        features=features,
        labels=labels,
        feature_names=list(FEATURE_NAMES),
        metadata=metadata,
        n_samples=n,
        sample_weights=sample_weights,
        scale_pos_weight=scale_pos_weight,
    )


@pytest.fixture
def synthetic_data() -> TrainingData:
    """1000 synthetic bets with a detectable +3% edge."""
    return make_synthetic_training_data(n=1_000, true_edge=0.03, seed=42)


@pytest.fixture
def large_synthetic_data() -> TrainingData:
    """2000 synthetic bets for more robust CPCV testing."""
    return make_synthetic_training_data(n=2_000, true_edge=0.03, seed=42)


@pytest.fixture
def zero_edge_data() -> TrainingData:
    """1000 synthetic bets with NO edge — model should show poor metrics."""
    return make_synthetic_training_data(n=1_000, true_edge=0.0, seed=42)
