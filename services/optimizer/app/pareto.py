"""Pareto frontier extraction (multi-objective: maximize ROI, minimize drawdown).

A trial is on the Pareto frontier if no other trial dominates it — i.e.,
no trial has BOTH higher ROI AND lower drawdown. We also require a
minimum sample size for inclusion (small-n trials can be lucky).

Returns a parallel boolean array (True = on frontier).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ParetoCandidate:
    trial_index: int
    oos_roi: float
    max_drawdown: float
    sample_size: int


def extract_pareto(
    candidates: list[ParetoCandidate],
    *,
    min_sample_size: int = 50,
) -> list[bool]:
    """Returns a parallel list — True if candidate is on the Pareto frontier."""
    n = len(candidates)
    on_frontier = [False] * n
    if n == 0:
        return on_frontier

    for i, ci in enumerate(candidates):
        if ci.sample_size < min_sample_size:
            continue
        dominated = False
        for j, cj in enumerate(candidates):
            if i == j or cj.sample_size < min_sample_size:
                continue
            # j dominates i iff j is at least as good on both axes
            # AND strictly better on at least one.
            if (
                cj.oos_roi >= ci.oos_roi
                and cj.max_drawdown <= ci.max_drawdown
                and (cj.oos_roi > ci.oos_roi or cj.max_drawdown < ci.max_drawdown)
            ):
                dominated = True
                break
        on_frontier[i] = not dominated
    return on_frontier
