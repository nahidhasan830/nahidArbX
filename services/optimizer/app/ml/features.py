"""Feature engineering for the ML path.

Each bet row is converted to a numerical feature vector + a label (1 if
profitable, 0 otherwise — the model learns to predict P(profitable)).

Design constraints:
- All features must be available at DETECTION time (no leakage from
  outcome). Closing odds / CLV are EXCLUDED from features.
- Categorical features one-hot encoded with a stable column ordering so a
  model trained on fold N can score fold N+1 even when categories differ.
- Pure pandas/numpy — no external feature store dep.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import polars as pl

# Numerical features safe to use at detection time.
NUMERICAL_FEATURES = [
    "ev_pct",
    "soft_odds",
    "sharp_odds",
    "sharp_true_prob",
    "soft_commission_pct",
    "tick_count",
]

# Categorical features — one-hot encoded with stable ordering.
CATEGORICAL_FEATURES = [
    "market_type",
    "soft_provider",
    "time_scope",
]


def make_label(df: pl.DataFrame) -> np.ndarray:
    """Binary label: 1 if outcome was a win (full or half), 0 otherwise."""
    outcomes = df["outcome"].to_numpy()
    return np.isin(outcomes, ["won", "half_won"]).astype(np.int8)


def build_feature_matrix(
    train_df: pl.DataFrame,
    test_df: pl.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame, list[str]]:
    """Build train + test feature matrices with stable one-hot columns.

    Categories are determined from the TRAIN frame only — test rows with
    unseen categories get all-zero columns for that feature (no peeking).
    Returns (X_train, X_test, feature_names) — dense pandas frames the
    XGBoost API accepts directly.
    """
    train_pd = train_df.to_pandas()
    test_pd = test_df.to_pandas()

    train_num = train_pd[NUMERICAL_FEATURES].fillna(0).astype(np.float32)
    test_num = (
        test_pd.reindex(columns=NUMERICAL_FEATURES).fillna(0).astype(np.float32)
    )

    # One-hot from train categories — apply same columns to test.
    train_cat = pd.get_dummies(
        train_pd[CATEGORICAL_FEATURES],
        columns=CATEGORICAL_FEATURES,
        prefix=CATEGORICAL_FEATURES,
        dtype=np.float32,
    )
    test_cat_raw = pd.get_dummies(
        test_pd[CATEGORICAL_FEATURES],
        columns=CATEGORICAL_FEATURES,
        prefix=CATEGORICAL_FEATURES,
        dtype=np.float32,
    )
    # Reindex test to train's column order; new columns get 0, missing dropped.
    test_cat = test_cat_raw.reindex(columns=train_cat.columns, fill_value=0.0)

    X_train = pd.concat([train_num, train_cat], axis=1)
    X_test = pd.concat([test_num, test_cat], axis=1)
    feature_names = list(X_train.columns)
    return X_train, X_test, feature_names
