"""Combinatorial Purged Cross-Validation (López de Prado).

Splits the chronologically-ordered bet rows into `n_groups` contiguous
groups. For every C(n_groups, n_test_groups) combination, marks
`n_test_groups` of them as test and the remainder as train. After purging
+ embargoing rows around test boundaries, this yields ~45 OOS paths from
n_groups=10, n_test_groups=2 — vastly more than walk-forward's 3-5.

Why purge + embargo: in time-series data, a bet's outcome leaks into
nearby rows via overlapping events. We drop train rows that share an
event_id with any test row, plus an additional time-based embargo
buffer around test boundaries.

Current behavior:
  - Event-aware purging removes all train rows whose event_id appears
    in the test set, not just adjacent-index rows.
  - Embargo still applies as a time-based safety margin around test
    boundaries to catch events not captured by event_id matching.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations

import numpy as np
import polars as pl


@dataclass(frozen=True)
class CpcvSplit:
    """One OOS path: train + test indices into the time-sorted DataFrame."""

    path_index: int
    train_indices: np.ndarray  # int64
    test_indices: np.ndarray  # int64


@dataclass(frozen=True)
class CpcvConfig:
    n_groups: int = 10
    n_test_groups: int = 2
    embargo_pct: float = 0.01  # 1% of total rows on each side of test boundaries


def make_cpcv_splits(df: pl.DataFrame, cfg: CpcvConfig) -> list[CpcvSplit]:
    """Build all C(n_groups, n_test_groups) OOS paths.

    Assumes `df` is already sorted by `event_start_time` (loader.py guarantees
    this).

    For each split we:
      1. Mark test rows by group membership.
      2. Collect all event_ids that appear in the test set.
      3. Remove from train any row whose event_id is in that test event set
         (prevents leakage from overlapping events).
      4. Additionally remove train rows within `embargo_pct` of test
         boundaries as a time-based safety net.
    """
    n = df.height
    if n == 0:
        return []
    if cfg.n_groups < 2 or cfg.n_test_groups < 1 or cfg.n_test_groups >= cfg.n_groups:
        raise ValueError(f"Invalid CPCV config: {cfg}")

    # Contiguous group assignment: row i ∈ group floor(i * n_groups / n)
    indices = np.arange(n, dtype=np.int64)
    group_id = (indices * cfg.n_groups // n).astype(np.int64)
    group_id = np.minimum(group_id, cfg.n_groups - 1)  # clamp last row

    embargo = max(1, int(round(n * cfg.embargo_pct)))

    # Pre-extract event_ids as a numpy array for fast set operations
    has_event_id = "event_id" in df.columns
    if has_event_id:
        event_ids = df["event_id"].to_numpy()
    else:
        event_ids = None

    splits: list[CpcvSplit] = []
    for path_idx, test_groups in enumerate(
        combinations(range(cfg.n_groups), cfg.n_test_groups)
    ):
        test_mask = np.isin(group_id, list(test_groups))
        test_indices = indices[test_mask]

        # Train mask = everything not in test
        train_mask = ~test_mask

        # Event-aware purging — remove train rows whose event_id
        # appears in the test set. This prevents leakage from bets on the
        # same event appearing in both train and test.
        if event_ids is not None:
            test_event_ids = set(event_ids[test_mask])
            for i in indices[train_mask]:
                if event_ids[i] in test_event_ids:
                    train_mask[i] = False

        # Time-based embargo: additionally remove train rows within
        # embargo_pct of test boundaries as a safety net.
        for ti in test_indices:
            lo = max(0, int(ti) - embargo)
            hi = min(n, int(ti) + embargo + 1)
            train_mask[lo:hi] = False

        train_indices = indices[train_mask]
        splits.append(
            CpcvSplit(
                path_index=path_idx,
                train_indices=train_indices,
                test_indices=test_indices,
            )
        )
    return splits


def expected_n_paths(cfg: CpcvConfig) -> int:
    from math import comb

    return comb(cfg.n_groups, cfg.n_test_groups)
