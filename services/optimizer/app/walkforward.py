"""Walk-Forward Analysis splitter — alternative to CPCV.

Where CPCV produces ~45 OOS paths from 10 groups (combinations), WFA
produces a single forward-marching sequence: train on rows [0..k], test on
rows (k..k+w], slide forward. Anchored variant keeps the training start
at 0; rolling variant keeps a fixed-width training window.

Why have both:
  - CPCV: more OOS paths → tighter CIs but assumes returns are exchangeable
    within groups (López de Prado).
  - WFA: simpler forward-only test — the textbook "would this strategy
    have worked if you ran it live from day 1?" check.
  - Cross-checking with both = stronger evidence than either alone.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import polars as pl

from .cpcv import CpcvSplit


@dataclass(frozen=True)
class WalkForwardConfig:
    n_folds: int = 6
    # If True: training window grows from row 0 (anchored).
    # If False: training window slides with the test fold (rolling).
    anchored: bool = True
    # Embargo as fraction of total rows applied between train and test.
    embargo_pct: float = 0.005


def make_walkforward_splits(
    df: pl.DataFrame, cfg: WalkForwardConfig
) -> list[CpcvSplit]:
    """Returns walk-forward splits in the same shape as CPCV — train + test
    index arrays — so the evaluator can consume them interchangeably.
    """
    n = df.height
    if n == 0 or cfg.n_folds < 2:
        return []
    fold_size = n // (cfg.n_folds + 1)  # +1 for the initial training block
    if fold_size < 5:
        # Too small to be meaningful.
        return []
    embargo = max(1, int(round(n * cfg.embargo_pct)))

    splits: list[CpcvSplit] = []
    for k in range(cfg.n_folds):
        # Test fold: rows [(k+1)*fold_size .. (k+2)*fold_size)
        test_start = (k + 1) * fold_size
        test_end = (k + 2) * fold_size if k < cfg.n_folds - 1 else n
        test_indices = np.arange(test_start, test_end, dtype=np.int64)

        # Training: rows [0 .. test_start - embargo) for anchored,
        # or (test_start - fold_size .. test_start - embargo) for rolling.
        train_end = max(0, test_start - embargo)
        if cfg.anchored:
            train_start = 0
        else:
            train_start = max(0, train_end - fold_size)
        train_indices = np.arange(train_start, train_end, dtype=np.int64)
        if train_indices.size == 0:
            continue
        splits.append(
            CpcvSplit(
                path_index=k,
                train_indices=train_indices,
                test_indices=test_indices,
            )
        )
    return splits
