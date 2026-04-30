"""Declarative search-space spec.

A `SearchSpace` describes which dimensions are tunable, their type, and
their range. The Optuna sampler reads this spec via `suggest_config()`
and proposes a `dict` of values that the evaluator consumes.

The spec is JSON-serializable so a run row's `search_space` column round-trips
cleanly between the Next.js UI (which lets users edit dimensions) and this
sidecar (which interprets them).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

import optuna

DimType = Literal["continuous", "discrete", "categorical", "boolean", "subset"]


@dataclass(frozen=True)
class Dimension:
    name: str
    kind: DimType
    # Continuous / Discrete: numeric bounds + step.
    low: float | None = None
    high: float | None = None
    step: float | None = None
    # Discrete / Categorical / Subset: option list.
    values: tuple[Any, ...] | None = None
    # Subset only: minimum number of selected items (defaults to 1).
    min_select: int = 1


@dataclass(frozen=True)
class SearchSpace:
    dimensions: tuple[Dimension, ...]

    @classmethod
    def from_json(cls, payload: dict[str, Any]) -> SearchSpace:
        """Parse the JSON shape stored in `optimization_runs.search_space`."""
        dims: list[Dimension] = []
        for raw in payload.get("dimensions", []):
            dims.append(
                Dimension(
                    name=raw["name"],
                    kind=raw["kind"],
                    low=raw.get("low"),
                    high=raw.get("high"),
                    step=raw.get("step"),
                    values=tuple(raw["values"]) if raw.get("values") is not None else None,
                    min_select=int(raw.get("min_select", 1)),
                )
            )
        return cls(dimensions=tuple(dims))

    def suggest_config(self, trial: optuna.Trial) -> dict[str, Any]:
        """Have Optuna sample one config from this space."""
        config: dict[str, Any] = {}
        for d in self.dimensions:
            if d.kind == "continuous":
                assert d.low is not None and d.high is not None
                if d.step is not None:
                    config[d.name] = trial.suggest_float(d.name, d.low, d.high, step=d.step)
                else:
                    config[d.name] = trial.suggest_float(d.name, d.low, d.high)

            elif d.kind == "discrete":
                # Optuna's int range when values are evenly spaced; categorical otherwise.
                assert d.values is not None
                config[d.name] = trial.suggest_categorical(d.name, list(d.values))

            elif d.kind == "categorical":
                assert d.values is not None
                config[d.name] = trial.suggest_categorical(d.name, list(d.values))

            elif d.kind == "boolean":
                config[d.name] = trial.suggest_categorical(d.name, [False, True])

            elif d.kind == "subset":
                # Each item is an independent boolean. Resample if the result
                # falls below `min_select`.
                assert d.values is not None
                selected = []
                for v in d.values:
                    if trial.suggest_categorical(f"{d.name}__{v}", [False, True]):
                        selected.append(v)
                if len(selected) < d.min_select:
                    selected = list(d.values[: d.min_select])
                config[d.name] = selected

            else:  # pragma: no cover
                raise ValueError(f"Unknown dimension kind: {d.kind}")
        return config


# ── Default search space (used when the run row's `search_space` is empty) ──
# Mirrors the `bettingSettings` row's tunables + the per-bet filters available
# in the canonical `bets` schema.

DEFAULT_SEARCH_SPACE = SearchSpace(
    dimensions=(
        # EV gate. Widened 2026-04-25 from [1.0, 6.0] → [0.25, 8.0] so the
        # sampler can find small-edge bets the old lower bound excluded.
        # Small +EV + big sample size can still be profitable; the composite
        # score already penalises tiny samples so we don't risk flukes.
        Dimension("min_ev_pct", "continuous", low=0.25, high=8.0, step=0.25),

        # Kelly fraction — clamped to [0.1, 0.5] (research-empirical sweet spot).
        Dimension("kelly_fraction", "continuous", low=0.10, high=0.50, step=0.05),
        # Bankroll cap on per-bet stake.
        Dimension("kelly_cap_pct", "continuous", low=2.0, high=15.0, step=1.0),
        # Sharp-probability filter — avoids longshots if hi, heavy faves if lo.
        Dimension("min_sharp_prob", "continuous", low=0.05, high=0.95, step=0.05),
        # Odds range filter. Widened 2026-04-25 lo 1.30→1.05 and hi 8.0→15.0
        # so heavy favourites + longshot regions of the book can be probed.
        Dimension("odds_lo", "continuous", low=1.05, high=3.00, step=0.05),
        Dimension("odds_hi", "continuous", low=2.00, high=15.00, step=0.5),
        # Re-tick threshold (filters one-off blips).
        Dimension("min_tick_count", "discrete", values=(1, 2, 3, 5)),
        # Pre-match only?
        Dimension("pre_match_only", "boolean"),
        # Sizing scheme.
        Dimension(
            "staking_scheme",
            "categorical",
            values=("flat", "kelly", "sqrt_kelly", "log_utility"),
        ),
        # Subset filters — discovered at run-creation time from the data
        # (the Next.js side fills `values` based on what's in the DB).
        # Default placeholder values here; overridden by the run row's space.
        Dimension(
            "soft_providers",
            "subset",
            values=("ninewickets-sportsbook", "ninewickets-exchange", "betconstruct"),
        ),
        Dimension(
            "market_types",
            "subset",
            values=(
                "MATCH_RESULT",
                "BTTS",
                "ASIAN_HANDICAP",
                "TOTAL_GOALS",
                "DOUBLE_CHANCE",
            ),
        ),
    )
)
