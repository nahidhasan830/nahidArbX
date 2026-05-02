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
    # Feature 5: soft_odds_age_ms
    features[:, 5] = rng.exponential(5000, size=n)
    # Feature 6: tick_count
    features[:, 6] = rng.integers(1, 50, size=n).astype(np.float32)
    # Feature 7: time_to_kickoff_min
    features[:, 7] = rng.uniform(5, 600, size=n)
    # Feature 8: movement_pct_sharp
    features[:, 8] = rng.normal(0, 1.5, size=n)
    # Feature 9: movement_pct_soft
    features[:, 9] = rng.normal(0, 2.0, size=n)
    # Feature 10: steam_move_sharp (binary)
    features[:, 10] = (rng.random(n) < 0.1).astype(np.float32)
    # Feature 11: steam_move_soft (binary)
    features[:, 11] = (rng.random(n) < 0.15).astype(np.float32)
    # Feature 12: sharp_direction
    features[:, 12] = rng.choice([-1, 0, 1], size=n).astype(np.float32)
    # Feature 13: soft_direction
    features[:, 13] = rng.choice([-1, 0, 1], size=n).astype(np.float32)
    # Feature 14: convergence_rate
    features[:, 14] = rng.normal(-0.5, 1.0, size=n)
    # Feature 15: tick_velocity
    features[:, 15] = rng.exponential(2.0, size=n)
    # Feature 16: provider_count
    features[:, 16] = rng.choice([2, 3, 4], size=n).astype(np.float32)
    # Feature 17: opening_sharp_odds
    features[:, 17] = features[:, 2] + rng.normal(0, 0.2, size=n)
    # Feature 18: market_type_encoded
    features[:, 18] = rng.integers(0, 8, size=n).astype(np.float32)
    # Feature 19: is_asian_line (binary)
    features[:, 19] = (rng.random(n) < 0.3).astype(np.float32)
    # Feature 20: commission_pct
    features[:, 20] = rng.choice([0.0, 2.0, 5.0], size=n).astype(np.float32)
    # Feature 21: kelly_fraction_raw
    features[:, 21] = rng.uniform(0.01, 0.15, size=n)
    # Feature 22: vig_pct
    features[:, 22] = rng.uniform(2.0, 8.0, size=n)

    # Generate labels with a signal correlated to ev_pct + sharp_true_prob
    # Higher EV and higher sharp_true_prob → more likely to win
    signal = (
        features[:, 0] * 0.03  # ev_pct
        + features[:, 1] * 0.5  # sharp_true_prob
        + features[:, 6] * 0.01  # tick_count
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
        "soft_commission_pct": features[:, 20].astype(np.float64).tolist(),
        "closing_sharp_odds": (soft_odds + rng.normal(0, 0.1, size=n)).tolist(),
        "clv_pct": rng.normal(1.0, 3.0, size=n).tolist(),
        "first_seen_at": [str(t) for t in timestamps],
        "event_start_time": [str(t + 3600) for t in timestamps],
        "event_id": [f"event-{i // 3}" for i in range(n)],
    })

    return TrainingData(
        features=features,
        labels=labels,
        feature_names=list(FEATURE_NAMES),
        metadata=metadata,
        n_samples=n,
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
