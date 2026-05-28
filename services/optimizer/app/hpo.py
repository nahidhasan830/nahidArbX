"""Hyperparameter optimization for the LightGBM betting classifier.

Uses Optuna's multivariate TPE sampler + HyperbandPruner — the BOHB-style
combo widely considered state-of-the-art for tabular HPO at this scale
(50-100 trials, 6-7 hyperparameters).

Architecture (3-tier validation, see ML_REBUILD_PLAN.md):
  - Stage A (this file): Optuna HPO, inner CV = purged walk-forward.
  - Stage B (trainer):   single outer holdout, last 3 months.
  - Stage C (trainer):   CPCV on the chosen config → DSR/PBO distribution.
  - Stage D (trainer):   final fit on ALL data with chosen params.

Why we don't use CPCV inside HPO: CPCV path geometry leaks into HPO
selection bias, undermining the very statistic (DSR) it's there to
provide. CPCV is reserved for *certifying* the chosen model, not picking
it. Walk-forward is honest, fast, and matches production retraining.

Optuna config rationale:
  - MultivariateTPE: handles correlated LGBM params (num_leaves ↔
    min_child_samples ↔ max_depth) far better than independent TPE.
  - HyperbandPruner: kills poor trials early, ~3× speedup at this scale.
  - 50 trials is the typical knee — TPE saturates well before 200.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable

import lightgbm as lgb
import numpy as np
import polars as pl

try:
    import optuna
    from optuna.pruners import HyperbandPruner
    from optuna.samplers import TPESampler
    OPTUNA_AVAILABLE = True
except ImportError:  # pragma: no cover
    OPTUNA_AVAILABLE = False

from .feature_names import FEATURE_COUNT
from .loader import TrainingData
from .policy import hpo_policy_objective_stats
from .walk_forward import WalkForwardConfig, make_walk_forward_splits

log = logging.getLogger(__name__)


# ── Search space ───────────────────────────────────────────────────────────
#
# 6 hyperparameters covering the dominant variance directions for LGBM
# on small/medium tabular data (200-10k samples). All other LGBM params
# (objective, monotone_constraints, sample_weight, etc.) come from
# trainer.DEFAULT_LGBM_PARAMS and are kept fixed.
SEARCH_SPACE: dict[str, dict] = {
    "num_leaves":        {"low": 7,    "high": 63,  "log": True,  "type": "int"},
    "max_depth":         {"low": 3,    "high": 8,   "log": False, "type": "int"},
    "learning_rate":     {"low": 0.01, "high": 0.2, "log": True,  "type": "float"},
    "min_child_samples": {"low": 10,   "high": 100, "log": True,  "type": "int"},
    "reg_alpha":         {"low": 1e-3, "high": 10,  "log": True,  "type": "float"},
    "reg_lambda":        {"low": 1e-3, "high": 10,  "log": True,  "type": "float"},
}


@dataclass
class HpoResult:
    """Outcome of an HPO sweep."""

    best_params: dict
    """LightGBM hyperparameters that won the sweep."""

    best_value: float
    """Optuna objective value (mean OOS unit-return × DSR floor) for the winner."""

    n_trials: int
    """Total number of trials actually run (may be < requested if pruned)."""

    per_trial_sharpes: list[float] = field(default_factory=list)
    """Mean OOS Sharpe across walk-forward folds, one per completed trial.

    Fed into the deflated-Sharpe formula in the trainer to discount the
    final config's Sharpe by the multiple-testing inflation it implies.
    """

    per_trial_objectives: list[float] = field(default_factory=list)

    per_trial_fold_returns: list[list[float]] = field(default_factory=list)
    """Per-completed-trial OOS policy unit returns by walk-forward fold.

    This is the matrix PBO needs: candidate configs × validation paths.
    It is diagnostic-only and does not affect the winning params or final fit.
    """


def optimize(
    data: TrainingData,
    *,
    base_params: dict,
    n_trials: int = 50,
    n_walk_forward_splits: int = 5,
    timeout_seconds: int | None = 600,
    seed: int = 42,
    progress_callback: Callable[[int, int, float], None] | None = None,
) -> HpoResult:
    """Run Optuna HPO to pick the best LightGBM hyperparameters.

    Args:
        data: full training corpus.
        base_params: fixed LightGBM params (objective, monotone_constraints,
            etc.) that HPO does NOT search over.
        n_trials: HPO budget. 50 is the practical knee for 6 hyperparams.
        n_walk_forward_splits: number of inner-CV folds per trial.
        timeout_seconds: hard wall-clock budget. None = no limit.
        seed: deterministic sampler seed.
    """
    if not OPTUNA_AVAILABLE:
        log.warning("optuna not installed — falling back to base params")
        return HpoResult(
            best_params=dict(base_params),
            best_value=float("nan"),
            n_trials=0,
        )

    if data.n_samples < 100:
        log.info("HPO skipped: n=%d too small, using base params", data.n_samples)
        return HpoResult(
            best_params=dict(base_params),
            best_value=float("nan"),
            n_trials=0,
        )

    splitter_df = pl.DataFrame({
        "event_id": data.metadata["event_id"].to_list(),
    })
    wf_cfg = WalkForwardConfig(n_splits=n_walk_forward_splits, embargo_pct=0.01)
    splits = make_walk_forward_splits(splitter_df, wf_cfg)
    if len(splits) < 2:
        log.warning(
            "HPO skipped: not enough walk-forward folds (%d) — using base params",
            len(splits),
        )
        return HpoResult(
            best_params=dict(base_params),
            best_value=float("nan"),
            n_trials=0,
        )

    log.info(
        "Optuna HPO start: %d trials × %d walk-forward folds (timeout=%ss)",
        n_trials, len(splits), timeout_seconds,
    )

    sampler = TPESampler(
        multivariate=True,
        group=True,
        warn_independent_sampling=False,
        seed=seed,
        n_startup_trials=10,
    )
    pruner = HyperbandPruner(min_resource=2, max_resource=len(splits), reduction_factor=3)
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    study = optuna.create_study(direction="maximize", sampler=sampler, pruner=pruner)

    per_trial_sharpes: list[float] = []
    per_trial_objectives: list[float] = []
    per_trial_fold_returns: list[list[float]] = []

    def objective(trial: "optuna.Trial") -> float:
        suggested = _suggest(trial)
        params = {**base_params, **suggested}
        # Inject a sane min_child_samples ceiling proportional to fold size.
        params.setdefault("verbose", -1)
        params.setdefault("force_col_wise", True)

        fold_unit_returns: list[float] = []
        fold_sharpes: list[float] = []

        for step_idx, split in enumerate(splits):
            train_idx = split.train_indices
            test_idx = split.test_indices
            if len(train_idx) < 20 or len(test_idx) < 5:
                continue
            metric, sharpe = _train_and_score_fold(
                data=data,
                train_idx=train_idx,
                test_idx=test_idx,
                params=params,
            )
            fold_unit_returns.append(metric)
            fold_sharpes.append(sharpe)

            # Hyperband: report the running mean so the pruner can kill
            # bad trials before they finish all folds.
            running_mean = float(np.mean(fold_unit_returns))
            trial.report(running_mean, step=step_idx)
            if trial.should_prune():
                raise optuna.TrialPruned()

        if not fold_unit_returns:
            raise optuna.TrialPruned()

        mean_unit_return = float(np.mean(fold_unit_returns))
        mean_sharpe = float(np.mean(fold_sharpes)) if fold_sharpes else 0.0

        # Composite objective: mean OOS unit return × max(mean_sharpe, 0).
        # Penalises strategies with negative Sharpe even if they have a
        # positive mean return on a few outlier folds (which is exactly
        # the kind of overfit a small-data sweep would otherwise find).
        sharpe_floor = max(mean_sharpe, 0.0)
        objective_value = mean_unit_return * (1.0 + sharpe_floor)

        per_trial_sharpes.append(mean_sharpe)
        per_trial_objectives.append(objective_value)
        per_trial_fold_returns.append(fold_unit_returns)
        if progress_callback is not None and (
            trial.number == 0
            or (trial.number + 1) % 10 == 0
            or (trial.number + 1) >= n_trials
        ):
            progress_callback(trial.number + 1, n_trials, objective_value)
        return objective_value

    study.optimize(
        objective,
        n_trials=n_trials,
        timeout=timeout_seconds,
        show_progress_bar=False,
        catch=(ValueError,),
    )

    best_trial_params = {**base_params, **study.best_trial.params}
    best_value = study.best_value if study.best_trial else float("nan")
    completed = sum(
        1 for t in study.trials if t.state == optuna.trial.TrialState.COMPLETE
    )

    log.info(
        "Optuna HPO done: %d completed trials, best objective=%.6f, best params=%s",
        completed, best_value, study.best_trial.params if study.best_trial else {},
    )

    return HpoResult(
        best_params=best_trial_params,
        best_value=best_value,
        n_trials=completed,
        per_trial_sharpes=per_trial_sharpes,
        per_trial_objectives=per_trial_objectives,
        per_trial_fold_returns=_rectangular_completed_paths(
            per_trial_fold_returns, expected_paths=len(splits),
        ),
    )


# ── Helpers ────────────────────────────────────────────────────────────────


def _suggest(trial: "optuna.Trial") -> dict[str, Any]:
    """Map our SEARCH_SPACE definition to Optuna's `suggest_*` API."""
    out: dict[str, Any] = {}
    for name, spec in SEARCH_SPACE.items():
        if spec["type"] == "int":
            out[name] = trial.suggest_int(
                name, spec["low"], spec["high"], log=spec.get("log", False),
            )
        else:
            out[name] = trial.suggest_float(
                name, spec["low"], spec["high"], log=spec.get("log", False),
            )
    return out


def _train_and_score_fold(
    *,
    data: TrainingData,
    train_idx: np.ndarray,
    test_idx: np.ndarray,
    params: dict,
) -> tuple[float, float]:
    """Train on `train_idx`, score the ML policy on `test_idx`.

    Returns (mean_unit_return, sharpe) for the bets the model would actually
    keep, not for the full baseline detector cohort.
    """
    X = data.features
    y = data.labels
    w = data.sample_weights

    X_train, y_train = X[train_idx], y[train_idx]
    w_train = w[train_idx] if w is not None else None
    X_test = X[test_idx]

    model = lgb.LGBMClassifier(**params)
    model.fit(
        X_train, y_train,
        sample_weight=w_train,
        callbacks=[lgb.log_evaluation(period=0)],
    )

    fold_meta = data.metadata[test_idx.tolist()]
    if "unit_return" in fold_meta.columns:
        unit_returns = fold_meta["unit_return"].to_numpy().astype(np.float64)
    else:
        unit_returns = fold_meta["pnl"].to_numpy().astype(np.float64)
    unit_returns = np.nan_to_num(unit_returns, nan=0.0)

    # Score the model's actual policy: keep only rows where model EV at the
    # offered odds is positive. This aligns HPO with runtime staking logic.
    try:
        preds = model.predict_proba(X_test)[:, 1]
        if not np.all(np.isfinite(preds)):
            return -1.0, 0.0
        mean_ur, sharpe, _selected_n = hpo_policy_objective_stats(
            preds, X_test, unit_returns,
        )
        return mean_ur, sharpe
    except Exception:
        return -1.0, 0.0

    return -1.0, 0.0


def feature_count() -> int:
    """Helper for tests/diagnostics — exposes the feature dim used by HPO."""
    return FEATURE_COUNT


def _rectangular_completed_paths(
    paths: list[list[float]],
    *,
    expected_paths: int,
) -> list[list[float]]:
    """Keep only full completed trial paths so PBO gets a valid matrix."""
    return [
        [float(v) for v in path]
        for path in paths
        if len(path) == expected_paths and all(np.isfinite(path))
    ]
