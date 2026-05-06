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

    # Feature 0: ev_pct — the primary signal
    features[:, 0] = rng.uniform(1.0, 15.0, size=n)
    # Feature 1: sharp_true_prob
    features[:, 1] = rng.uniform(0.15, 0.85, size=n)
    # Feature 2: soft_odds
    features[:, 2] = rng.uniform(1.3, 6.0, size=n)
    # Feature 3: adjusted_soft_odds
    features[:, 3] = features[:, 2] * rng.uniform(0.97, 1.0, size=n)
    # Feature 4: implied_prob_gap
    features[:, 4] = features[:, 1] - 1.0 / features[:, 2]
    # Feature 5: tick_count
    features[:, 5] = rng.integers(1, 50, size=n).astype(np.float32)
    # Feature 6: time_to_kickoff_min
    features[:, 6] = rng.uniform(5, 600, size=n)
    # Feature 7: movement_pct_sharp
    features[:, 7] = rng.normal(0, 1.5, size=n)
    # Feature 8: movement_pct_soft
    features[:, 8] = rng.normal(0, 2.0, size=n)
    # Feature 9: steam_move_sharp (binary)
    features[:, 9] = (rng.random(n) < 0.1).astype(np.float32)
    # Feature 10: steam_move_soft (binary)
    features[:, 10] = (rng.random(n) < 0.15).astype(np.float32)
    # Feature 11: sharp_direction
    features[:, 11] = rng.choice([-1, 0, 1], size=n).astype(np.float32)
    # Feature 12: soft_direction
    features[:, 12] = rng.choice([-1, 0, 1], size=n).astype(np.float32)
    # Feature 13: convergence_rate
    features[:, 13] = rng.normal(-0.5, 1.0, size=n)
    # Feature 14: tick_velocity
    features[:, 14] = rng.exponential(2.0, size=n)
    # Feature 15: provider_count
    features[:, 15] = rng.choice([2, 3, 4], size=n).astype(np.float32)
    # Feature 16: opening_sharp_odds
    features[:, 16] = features[:, 2] + rng.normal(0, 0.2, size=n)
    # Feature 17: market_type_encoded
    features[:, 17] = rng.integers(0, 8, size=n).astype(np.float32)
    # Feature 18: is_asian_line (binary)
    features[:, 18] = (rng.random(n) < 0.3).astype(np.float32)
    # Feature 19: kelly_fraction_raw
    features[:, 19] = rng.uniform(0.01, 0.15, size=n)
    # Feature 20: vig_pct
    features[:, 20] = rng.uniform(2.0, 8.0, size=n)
    # Feature 21: competition_tier
    features[:, 21] = rng.choice([1, 2, 3], size=n).astype(np.float32)
    # Feature 22: hours_since_line_opened
    features[:, 22] = rng.uniform(0, 48, size=n)
    # Feature 23: sharp_soft_spread
    features[:, 23] = rng.normal(0, 0.5, size=n)
    # Feature 24: num_markets_same_event
    features[:, 24] = rng.choice([1, 2, 3, 4, 5], size=n).astype(np.float32)

    # Generate labels with a signal correlated to ev_pct + sharp_true_prob
    # Higher EV and higher sharp_true_prob → more likely to win
    signal = (
        features[:, 0] * 0.03  # ev_pct
        + features[:, 1] * 0.5  # sharp_true_prob
        + features[:, 5] * 0.01  # tick_count
        + true_edge
    )
    win_prob = 1.0 / (1.0 + np.exp(-signal + 0.5))  # sigmoid
    labels = (rng.random(n) < win_prob).astype(np.int32)

    # Build metadata DataFrame
    soft_odds = features[:, 2].astype(np.float64)
    pnl = np.where(labels == 1, soft_odds - 1.0, -1.0)

    base_ts = 1735689600  # 2025-01-01 UTC
    timestamps = base_ts + np.sort(rng.integers(0, 180 * 86400, size=n))

    metadata = pl.DataFrame({
        "id": [f"synthetic-{i}" for i in range(n)],
        "outcome": ["won" if l == 1 else "lost" for l in labels],
        "pnl": pnl.tolist(),
        "soft_odds": soft_odds.tolist(),
        "sharp_true_prob": features[:, 1].astype(np.float64).tolist(),
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
