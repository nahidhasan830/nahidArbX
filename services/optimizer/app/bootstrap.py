"""Stationary block bootstrap for time-series-aware confidence intervals.

Plain bootstrap assumes IID samples. Bet outcomes are not IID — they have
modest autocorrelation (a hot streak in one league bleeds into the next
weekend). Politis-Romano stationary bootstrap preserves that structure
by resampling random-length blocks.

Implemented locally rather than via `arch` so the dependency footprint
stays small and the determinism contract is trivially auditable. We can
swap to `arch.bootstrap.StationaryBootstrap` if we need its richer API.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class BootstrapResult:
    mean: float
    ci_low: float
    ci_high: float


def stationary_bootstrap_ci(
    values: np.ndarray,
    *,
    seed: int,
    n_resamples: int = 1000,
    block_size: int | None = None,
    alpha: float = 0.05,
) -> BootstrapResult:
    """Returns (mean, low, high) of the supplied per-fold metric values.

    `block_size` defaults to `sqrt(n)` rounded up — the textbook choice for
    moderate autocorrelation.
    """
    n = values.size
    if n == 0:
        return BootstrapResult(0.0, 0.0, 0.0)
    if n == 1:
        return BootstrapResult(float(values[0]), float(values[0]), float(values[0]))

    if block_size is None:
        block_size = max(1, int(np.ceil(np.sqrt(n))))

    rng = np.random.default_rng(seed)
    p = 1.0 / block_size  # geometric distribution param for block lengths.

    means = np.empty(n_resamples, dtype=np.float64)
    for i in range(n_resamples):
        sample = np.empty(n, dtype=np.float64)
        pos = 0
        # Random starting block.
        idx = int(rng.integers(0, n))
        while pos < n:
            sample[pos] = values[idx]
            pos += 1
            # Continue the current block, or pick a new random start.
            if rng.random() < p:
                idx = int(rng.integers(0, n))
            else:
                idx = (idx + 1) % n
        means[i] = sample.mean()

    lo = float(np.quantile(means, alpha / 2.0))
    hi = float(np.quantile(means, 1.0 - alpha / 2.0))
    return BootstrapResult(mean=float(values.mean()), ci_low=lo, ci_high=hi)
