"""Shared fixtures for AlphaSearch optimizer correctness tests.

The sidecar's pure functions (`evaluate_trial`, `make_cpcv_splits`,
`stationary_bootstrap_ci`, `pbo_score`, …) all take a Polars DataFrame
and a config dict. We build synthetic DataFrames here so tests don't
touch Postgres and the answers are controllable.

Key fixture: `synthetic_bets(n, true_edge, seed)` generates rows whose
P(win) = 1/odds + true_edge. With `true_edge=0`, no config can be
profitable — the optimizer's statistical safeguards must report that
honestly (placebo test). With `true_edge=0.03`, every reasonable
config should find a ~3% edge (known-answer test).
"""

from __future__ import annotations

import numpy as np
import polars as pl
import pytest


# Schema kept in sync with loader.py's Polars output. Any new column the
# evaluator/CPCV reads must be added here.
_SCHEMA = {
    "id": pl.Utf8,
    "event_start_time": pl.Datetime(time_unit="us"),
    "soft_provider": pl.Utf8,
    "market_type": pl.Utf8,
    "time_scope": pl.Utf8,
    "soft_odds": pl.Float64,
    "soft_commission_pct": pl.Float64,
    "sharp_true_prob": pl.Float64,
    "tick_count": pl.Int64,
    "ev_pct": pl.Float64,
    "outcome": pl.Utf8,
    "pnl": pl.Float64,
    "closing_odds": pl.Float64,
    "clv_pct": pl.Float64,
}


def make_synthetic_bets(
    n: int = 1_000,
    *,
    true_edge: float = 0.0,
    seed: int = 42,
) -> pl.DataFrame:
    """Generate `n` synthetic bets, sorted chronologically.

    ``true_edge`` controls the real-world win probability:
        P(win) = 1/soft_odds + true_edge
    so at ``true_edge=0`` the bets have zero edge (pure market price)
    and at ``true_edge=0.03`` every bet is +3% EV vs a fair book.

    Rows carry all columns the evaluator expects. Outcome is sampled
    from the true win-probability; `pnl` is filled exactly the way
    `_compute_pnl` does, so any non-zero ROI the optimizer reports must
    come from a real signal in the data, not from simulation drift.
    """
    rng = np.random.default_rng(seed)

    # Monotonic timestamps over 180 days — shape matches real bet history.
    base_ns = np.int64(1_735_689_600_000_000_000)  # 2025-01-01 UTC in ns
    day_ns = np.int64(86_400_000_000_000)
    ts = base_ns + rng.integers(0, 180 * day_ns, size=n)
    ts.sort()

    soft_odds = rng.uniform(1.5, 5.0, size=n)
    fair_prob = 1.0 / soft_odds
    win_prob = np.clip(fair_prob + true_edge, 0.0, 0.99)
    outcome_bool = rng.random(n) < win_prob
    outcome = np.where(outcome_bool, "won", "lost")

    providers = np.array(
        ["ninewickets-exchange", "ninewickets-sportsbook", "betconstruct"]
    )
    soft_provider = providers[rng.integers(0, len(providers), size=n)]
    # Exchange has a 2% commission; sportsbooks are 0%.
    commission = np.where(soft_provider == "ninewickets-exchange", 2.0, 0.0)

    markets = np.array(["MATCH_ODDS", "OVER_UNDER_2_5", "ASIAN_HANDICAP", "BTTS"])
    market_type = markets[rng.integers(0, len(markets), size=n)]

    sharp_true_prob = fair_prob
    ev_pct = (soft_odds * sharp_true_prob - 1.0) * 100.0

    # Simulate P&L exactly the way the sidecar's _compute_pnl would, so
    # test assertions about ROI are internally consistent.
    stake_unit = 1.0
    pnl = np.where(
        outcome == "won",
        stake_unit * (soft_odds - 1.0),
        np.where(outcome == "lost", -stake_unit, 0.0),
    )

    closing_odds = soft_odds + rng.normal(0.0, 0.05, size=n)
    clv_pct = (soft_odds / np.maximum(closing_odds, 1.01) - 1.0) * 100.0

    df = pl.DataFrame(
        {
            "id": [f"synthetic-{i}" for i in range(n)],
            "event_start_time": ts,
            "soft_provider": soft_provider.tolist(),
            "market_type": market_type.tolist(),
            "time_scope": ["pre_match"] * n,
            "soft_odds": soft_odds.tolist(),
            "soft_commission_pct": commission.tolist(),
            "sharp_true_prob": sharp_true_prob.tolist(),
            "tick_count": [5] * n,
            "ev_pct": ev_pct.tolist(),
            "outcome": outcome.tolist(),
            "pnl": pnl.tolist(),
            "closing_odds": closing_odds.tolist(),
            "clv_pct": clv_pct.tolist(),
        },
        schema_overrides={
            "event_start_time": pl.Datetime(time_unit="ns"),
        },
    )

    # Cast timestamp to microseconds to match loader.py's output.
    return df.with_columns(pl.col("event_start_time").cast(pl.Datetime("us"))).sort(
        "event_start_time"
    )


@pytest.fixture
def zero_edge_bets() -> pl.DataFrame:
    """1,000 bets with no edge — expected OOS ROI ≈ 0 with bounded noise."""
    return make_synthetic_bets(n=1_000, true_edge=0.0, seed=42)


@pytest.fixture
def positive_edge_bets() -> pl.DataFrame:
    """2,000 bets with a known +3% edge — every reasonable config should find it."""
    return make_synthetic_bets(n=2_000, true_edge=0.03, seed=42)


@pytest.fixture
def default_config() -> dict:
    """A representative trial config — wide-enough filters to keep most rows."""
    return {
        "min_ev_pct": 0.0,
        "odds_lo": 1.5,
        "odds_hi": 5.0,
        "staking_scheme": "kelly",
        "kelly_fraction": 0.25,
        "kelly_cap_pct": 5.0,
    }
