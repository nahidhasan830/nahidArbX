"""Purged walk-forward cross-validation.

A computationally cheap CV scheme designed for use as the *inner loop* of
hyperparameter optimization. Unlike CPCV (which generates 45+ paths and
is reserved for final risk certification), walk-forward produces a small
number of strictly time-ordered train/test splits, mimicking the way
the model will actually be used in production.

Why walk-forward for HPO:
  - HPO needs many fast evaluations (50-100 trials).
  - CPCV in the inner loop is statistically unsound (path geometry leaks
    into HPO selection bias).
  - Walk-forward respects temporal causality and is what the production
    deployment looks like at every retrain.

Splits are returned as `CpcvSplit` instances so they're drop-in
compatible with the rest of the trainer.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import polars as pl

from .cpcv import CpcvSplit


@dataclass(frozen=True)
class WalkForwardConfig:
    """Configuration for purged walk-forward CV."""

    n_splits: int = 5
    """Number of expanding-window train/test splits."""

    embargo_pct: float = 0.01
    """Fraction of total rows to embargo around each test boundary."""

    min_train_size_pct: float = 0.3
    """First train fold must contain at least this fraction of total rows.

    Prevents tiny initial train sets that produce useless metrics.
    """


def make_walk_forward_splits(
    df: pl.DataFrame,
    cfg: WalkForwardConfig,
) -> list[CpcvSplit]:
    """Generate purged walk-forward CV splits.

    Algorithm:
      - Reserve the last `1 / (n_splits + 1)` of the data as a final
        out-of-sample tail (acts as outer holdout buffer if needed).
      - Split the remaining data into `n_splits` contiguous test windows.
      - For each split: train = all rows before the test window's start
        (minus same-event purge minus embargo), test = the window itself.
      - The model trains on a chronologically expanding window — the same
        pattern as production retraining.

    Returns CpcvSplit objects so the trainer can use the same fold loop.
    """
    n = df.height
    if n == 0:
        return []
    if cfg.n_splits < 2:
        raise ValueError(f"n_splits must be >= 2, got {cfg.n_splits}")

    # Reserve a tail so the very last test fold isn't pinned to the data edge.
    # This keeps the walk-forward windows away from the boundary that the
    # outer holdout will use.
    test_pool_end = int(n * (cfg.n_splits / (cfg.n_splits + 1)))
    test_pool_end = max(test_pool_end, cfg.n_splits)

    min_train = max(20, int(n * cfg.min_train_size_pct))
    test_window = max(5, (test_pool_end - min_train) // cfg.n_splits)
    if test_window <= 0:
        return []

    embargo = max(1, int(round(n * cfg.embargo_pct)))

    has_event_id = "event_id" in df.columns
    event_ids = df["event_id"].to_numpy() if has_event_id else None

    indices = np.arange(n, dtype=np.int64)
    splits: list[CpcvSplit] = []

    for k in range(cfg.n_splits):
        test_start = min_train + k * test_window
        test_end = min(test_start + test_window, test_pool_end)
        if test_end - test_start < 5:
            break

        test_idx = indices[test_start:test_end]
        if test_idx.size == 0:
            continue

        # Train mask = rows strictly before this test window
        train_mask = np.zeros(n, dtype=bool)
        train_mask[: test_start] = True

        # Event-aware purge
        if event_ids is not None:
            test_event_ids = set(event_ids[test_start:test_end])
            train_indices_to_check = indices[train_mask]
            for i in train_indices_to_check:
                if event_ids[i] in test_event_ids:
                    train_mask[i] = False

        # Time embargo around the test window (mostly the front edge for WF)
        lo = max(0, int(test_start) - embargo)
        train_mask[lo:test_start] = False

        train_idx = indices[train_mask]
        if train_idx.size < 10:
            continue

        splits.append(
            CpcvSplit(
                path_index=k,
                train_indices=train_idx,
                test_indices=test_idx,
            )
        )

    return splits
