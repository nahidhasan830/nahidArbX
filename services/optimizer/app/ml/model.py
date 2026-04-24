"""XGBoost classifier + isotonic calibration.

Trains on the train fold, predicts calibrated P(profitable) on the test fold.
Calibration uses an internal holdout from the train set (Platt-equivalent —
sklearn's CalibratedClassifierCV with method='isotonic').

ML hyperparameters are sampled by Optuna per trial (so the same study can
compare different XGBoost configurations through the same CPCV harness).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

# Imports are deferred so the optimizer service can boot even if the
# optional [ml] extra isn't installed in the venv.
try:
    import xgboost as xgb  # type: ignore[import-untyped]
    from sklearn.calibration import CalibratedClassifierCV
    from sklearn.model_selection import StratifiedKFold

    ML_DEPS_AVAILABLE = True
except ImportError:  # pragma: no cover
    xgb = None  # type: ignore[assignment]
    CalibratedClassifierCV = None  # type: ignore[assignment]
    StratifiedKFold = None  # type: ignore[assignment]
    ML_DEPS_AVAILABLE = False


@dataclass(frozen=True)
class MlConfig:
    n_estimators: int = 200
    max_depth: int = 4
    learning_rate: float = 0.1
    subsample: float = 0.9
    colsample_bytree: float = 0.9
    min_child_weight: int = 5
    # Threshold above which a bet is taken; tuned by Optuna alongside the
    # XGBoost hyperparams.
    threshold: float = 0.55
    seed: int = 42


def train_and_predict(
    X_train: pd.DataFrame,
    y_train: np.ndarray,
    X_test: pd.DataFrame,
    cfg: MlConfig,
) -> np.ndarray:
    """Returns calibrated P(profitable) for each row in X_test.

    Falls back to a uniform 0.5 prediction array if the optional [ml]
    extra isn't installed (so a misconfigured deployment doesn't crash —
    the trial just ends up with no surviving bets).
    """
    if not ML_DEPS_AVAILABLE:
        return np.full(len(X_test), 0.5, dtype=np.float32)

    # Need at least 20 samples per class for a meaningful CV calibration;
    # otherwise just return raw predictions.
    pos = int(y_train.sum())
    neg = int(len(y_train) - pos)
    if pos < 20 or neg < 20:
        base = xgb.XGBClassifier(
            n_estimators=cfg.n_estimators,
            max_depth=cfg.max_depth,
            learning_rate=cfg.learning_rate,
            subsample=cfg.subsample,
            colsample_bytree=cfg.colsample_bytree,
            min_child_weight=cfg.min_child_weight,
            tree_method="hist",
            random_state=cfg.seed,
            eval_metric="logloss",
            verbosity=0,
        )
        base.fit(X_train, y_train)
        return base.predict_proba(X_test)[:, 1].astype(np.float32)

    base = xgb.XGBClassifier(
        n_estimators=cfg.n_estimators,
        max_depth=cfg.max_depth,
        learning_rate=cfg.learning_rate,
        subsample=cfg.subsample,
        colsample_bytree=cfg.colsample_bytree,
        min_child_weight=cfg.min_child_weight,
        tree_method="hist",
        random_state=cfg.seed,
        eval_metric="logloss",
        verbosity=0,
    )
    skf = StratifiedKFold(n_splits=3, shuffle=True, random_state=cfg.seed)
    calibrated = CalibratedClassifierCV(
        estimator=base,
        method="isotonic",
        cv=skf,
    )
    calibrated.fit(X_train, y_train)
    return calibrated.predict_proba(X_test)[:, 1].astype(np.float32)
