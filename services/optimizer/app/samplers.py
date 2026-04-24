"""Optuna study factory.

Three sampler modes are supported:
- `random`  — uniform random over the space (unbiased baseline coverage)
- `tpe`     — Tree-structured Parzen Estimator (Bayesian; converges faster)
- `nsga2`   — multi-objective genetic (returns Pareto frontier directly; Phase 2)
- `ensemble`— random warm-up (first 200 trials) → TPE refinement

All paths seed off the supplied `rng_seed` so runs are reproducible.
"""

from __future__ import annotations

from typing import Literal

import optuna

SamplerKind = Literal["random", "tpe", "nsga2", "ensemble"]


def build_study(
    *,
    algorithm: SamplerKind,
    seed: int,
    multi_objective: bool = False,
) -> optuna.Study:
    """Create an in-memory Optuna study (we persist trials ourselves)."""
    if algorithm == "random":
        sampler = optuna.samplers.RandomSampler(seed=seed)
    elif algorithm == "tpe":
        # `n_startup_trials=20` — pure-random warm-up before TPE's KDE fits.
        sampler = optuna.samplers.TPESampler(seed=seed, n_startup_trials=20)
    elif algorithm == "nsga2":
        sampler = optuna.samplers.NSGAIISampler(seed=seed, population_size=50)
    elif algorithm == "ensemble":
        # We swap samplers mid-run via `set_sampler()` in runner.py; start with TPE.
        sampler = optuna.samplers.TPESampler(seed=seed, n_startup_trials=200)
    else:  # pragma: no cover
        raise ValueError(f"Unknown sampler algorithm: {algorithm}")

    if multi_objective:
        # Two objectives: maximize OOS ROI, minimize max drawdown.
        return optuna.create_study(
            directions=["maximize", "minimize"],
            sampler=sampler,
        )
    return optuna.create_study(direction="maximize", sampler=sampler)


def is_multi_objective(algorithm: SamplerKind) -> bool:
    """NSGA-II is inherently multi-objective; others are single-objective
    (we still extract the Pareto frontier post-hoc from their trial results)."""
    return algorithm == "nsga2"
