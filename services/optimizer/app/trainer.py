"""LightGBM training with CPCV cross-validation and quality metrics.

Trains a binary classifier (P(profitable) for each bet) using Combinatorial
Purged Cross-Validation to avoid look-ahead bias. Computes comprehensive
quality metrics including DSR, PBO, AUC-ROC, calibration error, and SHAP
feature importance.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field

import lightgbm as lgb
import numpy as np
from scipy import stats
from sklearn.calibration import calibration_curve
from sklearn.metrics import (
    accuracy_score,
    log_loss,
    roc_auc_score,
)

from .cpcv import CpcvConfig, CpcvSplit, make_cpcv_splits
from .feature_names import FEATURE_COUNT, FEATURE_NAMES
from .loader import TrainingData
from .scoring import deflated_sharpe, pbo_score, score_bucket_analysis, ScoreBucketReport

log = logging.getLogger(__name__)

# Default LightGBM hyperparameters — Phase 6 conservative tuning for
# small/medium betting datasets (typically 500-5000 samples).
DEFAULT_LGBM_PARAMS: dict = {
    "objective": "binary",
    "metric": "binary_logloss",
    "boosting_type": "gbdt",
    "num_leaves": 15,
    "max_depth": 5,
    "learning_rate": 0.03,
    "n_estimators": 500,
    # min_child_samples is injected adaptively by _adaptive_min_child_samples()
    "subsample": 0.8,
    "colsample_bytree": 0.6,
    "reg_alpha": 0.1,
    "reg_lambda": 1.0,
    "random_state": 42,
    "verbose": -1,
    "force_col_wise": True,
    # scale_pos_weight is injected dynamically from TrainingData.scale_pos_weight
}

# CPCV config: 10 groups, pick 2 for test → 45 paths.
DEFAULT_CPCV_CONFIG = CpcvConfig(n_groups=10, n_test_groups=2, embargo_pct=0.01)


@dataclass(frozen=True)
class TrainingMetrics:
    """Quality metrics from the CPCV training run."""

    # Classification metrics (aggregated OOS)
    auc_roc: float
    accuracy: float
    log_loss_val: float
    calibration_error: float

    # Financial metrics (aggregated OOS)
    oos_roi_mean: float
    oos_clv_mean: float

    # Overfitting diagnostics
    dsr: float   # Deflated Sharpe Ratio
    pbo: float   # Probability of Backtest Overfitting

    # Training info
    n_samples: int
    n_positive: int
    n_negative: int
    n_folds: int
    scale_pos_weight: float | None = None

    # Per-fold metrics for PBO/DSR computation
    per_fold_sharpes: list[float] = field(default_factory=list)

    # SHAP feature importance (feature_name → mean |SHAP|)
    feature_importance: dict[str, float] = field(default_factory=dict)

    # Score bucket calibration (Phase 6)
    score_bucket_report: ScoreBucketReport | None = None


@dataclass
class TrainingResult:
    """Complete training output: model + metrics."""

    model: lgb.LGBMClassifier
    metrics: TrainingMetrics
    oos_predictions: np.ndarray   # shape (n,) — P(positive) for each sample
    oos_labels: np.ndarray        # shape (n,) — true labels


def train(
    data: TrainingData,
    *,
    lgbm_params: dict | None = None,
    cpcv_config: CpcvConfig | None = None,
) -> TrainingResult:
    """Train LightGBM via CPCV and compute quality metrics.

    Returns a TrainingResult with the final model trained on ALL data
    (for deployment) plus metrics computed from OOS predictions only
    (for honest evaluation).
    """
    params = {**DEFAULT_LGBM_PARAMS, **(lgbm_params or {})}
    cfg = cpcv_config or DEFAULT_CPCV_CONFIG

    # Inject adaptive min_child_samples based on dataset size
    if "min_child_samples" not in params and "min_child_samples" not in (lgbm_params or {}):
        params["min_child_samples"] = _adaptive_min_child_samples(len(data.labels))

    # Inject scale_pos_weight from TrainingData if available and not already overridden
    if data.scale_pos_weight is not None and "scale_pos_weight" not in params:
        params["scale_pos_weight"] = data.scale_pos_weight

    X = data.features
    y = data.labels
    w = data.sample_weights  # may be None
    n_samples = len(y)

    log.info(
        "Training LightGBM: %d samples, %d features, scale_pos_weight=%s, sample_weights=%s",
        n_samples, FEATURE_COUNT,
        params.get("scale_pos_weight", "none"),
        "yes" if w is not None else "no",
    )

    # ── Build CPCV splits ──────────────────────────────────────────────
    # CPCV operates on a time-sorted DataFrame. We use the metadata's
    # first_seen_at ordering (loader guarantees ORDER BY first_seen_at).
    # Build a dummy Polars DataFrame with just event_id for purging.
    import polars as pl

    splitter_df = pl.DataFrame({
        "event_id": data.metadata["event_id"].to_list(),
    })

    splits = make_cpcv_splits(splitter_df, cfg)
    n_folds = len(splits)
    log.info("CPCV: %d folds (groups=%d, test_groups=%d)", n_folds, cfg.n_groups, cfg.n_test_groups)

    # ── Fold-level training ────────────────────────────────────────────
    oos_preds = np.full(n_samples, np.nan, dtype=np.float64)
    per_fold_sharpes: list[float] = []
    per_fold_rois: list[float] = []  # For PBO matrix

    for split in splits:
        train_idx = split.train_indices
        test_idx = split.test_indices

        if len(train_idx) < 10 or len(test_idx) < 5:
            log.debug("Fold %d: too few samples (train=%d, test=%d), skipping",
                      split.path_index, len(train_idx), len(test_idx))
            continue

        X_train, y_train = X[train_idx], y[train_idx]
        X_test, y_test = X[test_idx], y[test_idx]
        w_train = w[train_idx] if w is not None else None

        model = lgb.LGBMClassifier(**params)
        model.fit(
            X_train, y_train,
            sample_weight=w_train,
            eval_set=[(X_test, y_test)],
            callbacks=[lgb.log_evaluation(period=0)],  # silence per-iteration logs
        )

        # P(positive) for OOS samples
        fold_preds = model.predict_proba(X_test)[:, 1]
        oos_preds[test_idx] = fold_preds

        # Per-fold financial Sharpe (for DSR/PBO)
        fold_meta = data.metadata[test_idx.tolist()]
        fold_pnl = fold_meta["pnl"].to_numpy().astype(np.float64)
        fold_pnl = np.nan_to_num(fold_pnl, nan=0.0)

        fold_stakes = fold_meta["soft_odds"].to_numpy().astype(np.float64)
        fold_stakes = np.where(fold_stakes > 0, 1.0, 0.0)  # unit stakes

        with np.errstate(divide="ignore", invalid="ignore"):
            returns = np.where(fold_stakes > 0, fold_pnl / fold_stakes, 0.0)

        if len(returns) > 1 and returns.std() > 0:
            sharpe = float(returns.mean() / returns.std() * math.sqrt(len(returns)))
        else:
            sharpe = 0.0
        per_fold_sharpes.append(sharpe)

        total_stake = float(fold_stakes.sum()) if fold_stakes.sum() > 0 else 1.0
        roi = float(fold_pnl.sum() / total_stake * 100.0)
        per_fold_rois.append(roi)

    # ── Aggregate OOS metrics ──────────────────────────────────────────
    # Only use samples that got OOS predictions
    valid_mask = ~np.isnan(oos_preds)
    oos_valid = oos_preds[valid_mask]
    labels_valid = y[valid_mask]

    if len(oos_valid) < 10:
        log.warning("Too few OOS predictions (%d), metrics will be unreliable", len(oos_valid))

    # AUC-ROC
    try:
        auc = float(roc_auc_score(labels_valid, oos_valid))
    except ValueError:
        auc = 0.5  # Single class in labels

    # Accuracy (at 0.5 threshold)
    acc = float(accuracy_score(labels_valid, (oos_valid > 0.5).astype(int)))

    # Log loss
    ll = float(log_loss(labels_valid, np.clip(oos_valid, 1e-7, 1 - 1e-7)))

    # Calibration error (ECE — expected calibration error)
    cal_err = _expected_calibration_error(labels_valid, oos_valid)

    # OOS ROI
    oos_roi = float(np.mean(per_fold_rois)) if per_fold_rois else 0.0

    # OOS CLV — average CLV% across OOS samples that have valid CLV data
    clv_col = data.metadata["clv_pct"].to_numpy().astype(np.float64)
    clv_valid = clv_col[valid_mask]
    finite_clv = clv_valid[np.isfinite(clv_valid)]
    oos_clv = float(finite_clv.mean()) if len(finite_clv) > 0 else 0.0

    # ── Overfitting diagnostics ────────────────────────────────────────
    # DSR: how confident is the best fold's Sharpe after trial count adjustment?
    sharpe_arr = np.array(per_fold_sharpes)
    best_sharpe = float(sharpe_arr.max()) if len(sharpe_arr) > 0 else 0.0
    sharpe_var = float(np.var(sharpe_arr, ddof=1)) if len(sharpe_arr) > 1 else 0.0

    dsr = deflated_sharpe(
        best_sharpe,
        n=n_samples,
        n_trials=n_folds,
        sharpe_variance_across_trials=sharpe_var,
        skew=float(stats.skew(sharpe_arr)) if len(sharpe_arr) > 2 else 0.0,
        kurtosis=float(stats.kurtosis(sharpe_arr, fisher=False)) if len(sharpe_arr) > 3 else 3.0,
    )

    # PBO: build a per-fold ROI matrix (1 trial × N paths)
    # With a single model type, PBO tests whether the specific CPCV fold
    # selection is overfit.
    pbo_val = pbo_score(
        [per_fold_rois],  # single "trial" — the LightGBM model
        n_subsamples=200,
        seed=42,
    )

    # ── Train final model on ALL data ──────────────────────────────────
    log.info("Training final model on all %d samples", n_samples)
    final_model = lgb.LGBMClassifier(**params)
    final_model.fit(X, y, sample_weight=w)

    # ── SHAP feature importance ────────────────────────────────────────
    feature_importance = _compute_shap_importance(final_model, X)

    # ── Score bucket calibration (Phase 6) ─────────────────────────────
    pnl_arr = data.metadata["pnl"].to_numpy().astype(np.float64)
    pnl_valid = np.nan_to_num(pnl_arr[valid_mask], nan=0.0)
    clv_for_buckets = clv_valid if len(finite_clv) > 0 else None
    bucket_report = score_bucket_analysis(
        oos_valid, labels_valid, pnl_valid, clv_for_buckets,
    )

    _log_bucket_report(bucket_report)

    metrics = TrainingMetrics(
        auc_roc=round(auc, 4),
        accuracy=round(acc, 4),
        log_loss_val=round(ll, 6),
        calibration_error=round(cal_err, 6),
        oos_roi_mean=round(oos_roi, 4),
        oos_clv_mean=round(oos_clv, 4),
        dsr=round(dsr, 4),
        pbo=round(pbo_val, 4),
        n_samples=n_samples,
        n_positive=int(y.sum()),
        n_negative=int((y == 0).sum()),
        n_folds=n_folds,
        scale_pos_weight=data.scale_pos_weight,
        per_fold_sharpes=[round(s, 4) for s in per_fold_sharpes],
        feature_importance=feature_importance,
        score_bucket_report=bucket_report,
    )

    log.info(
        "Training complete: AUC=%.4f, DSR=%.4f, PBO=%.4f, ROI=%.2f%%, CLV=%.2f%%, "
        "bucket_monotonicity=%.2f",
        metrics.auc_roc, metrics.dsr, metrics.pbo, metrics.oos_roi_mean,
        metrics.oos_clv_mean, bucket_report.roi_monotonicity,
    )

    return TrainingResult(
        model=final_model,
        metrics=metrics,
        oos_predictions=oos_preds,
        oos_labels=y,
    )


def _expected_calibration_error(
    y_true: np.ndarray,
    y_prob: np.ndarray,
    n_bins: int = 10,
) -> float:
    """Compute Expected Calibration Error (ECE).

    Measures how well predicted probabilities match observed frequencies.
    Lower is better. 0.0 = perfectly calibrated.
    """
    try:
        fraction_of_positives, mean_predicted = calibration_curve(
            y_true, y_prob, n_bins=n_bins, strategy="uniform",
        )
    except ValueError:
        return 0.0

    # Compute bin counts for weighting
    bin_edges = np.linspace(0, 1, n_bins + 1)
    bin_indices = np.digitize(y_prob, bin_edges[1:-1])
    bin_counts = np.array([np.sum(bin_indices == i) for i in range(n_bins)])

    # Only use bins that calibration_curve actually returned
    # (it skips empty bins)
    n_returned = len(fraction_of_positives)
    if n_returned == 0:
        return 0.0

    # Weight by bin count
    non_empty = bin_counts[bin_counts > 0][:n_returned]
    weights = non_empty / non_empty.sum() if non_empty.sum() > 0 else np.ones(n_returned)

    ece = float(np.sum(weights * np.abs(fraction_of_positives - mean_predicted)))
    return ece


def _compute_shap_importance(
    model: lgb.LGBMClassifier,
    X: np.ndarray,
    max_samples: int = 500,
) -> dict[str, float]:
    """Compute mean |SHAP| per feature for interpretability.

    Uses a subsample for speed on large datasets.
    """
    try:
        import shap

        if X.shape[0] > max_samples:
            rng = np.random.default_rng(42)
            idx = rng.choice(X.shape[0], max_samples, replace=False)
            X_sub = X[idx]
        else:
            X_sub = X

        explainer = shap.TreeExplainer(model)
        shap_values = explainer.shap_values(X_sub)

        # For binary classification, shap_values may be a list [neg, pos]
        if isinstance(shap_values, list):
            shap_values = shap_values[1]  # positive class

        mean_abs = np.abs(shap_values).mean(axis=0)
        importance = {}
        for i, name in enumerate(FEATURE_NAMES):
            importance[name] = round(float(mean_abs[i]), 6)

        return importance
    except Exception as e:
        log.warning("SHAP computation failed: %s", e)
        return {}


def _adaptive_min_child_samples(n_samples: int) -> int:
    """Compute adaptive min_child_samples based on dataset size.

    Small datasets need fewer min_child_samples to avoid underfitting.
    Ranges from 5 (n≤200) to 20 (n≥2000), linearly interpolated.
    """
    if n_samples <= 200:
        return 5
    if n_samples >= 2000:
        return 20
    # Linear interpolation between 5 and 20 over [200, 2000]
    return int(5 + (n_samples - 200) / (2000 - 200) * 15)


def _log_bucket_report(report: 'ScoreBucketReport') -> None:
    """Log the score bucket report in a readable table format."""
    log.info("Score bucket calibration report:")
    log.info("  %-10s %6s %8s %8s %8s %8s", "Bucket", "Count", "WinRate", "ROI%", "CLV%", "MeanScr")
    for b in report.buckets:
        clv_str = f"{b.mean_clv_pct:8.2f}" if math.isfinite(b.mean_clv_pct) else "     N/A"
        log.info(
            "  %-10s %6d %7.1f%% %7.1f%% %s %8.4f",
            b.label, b.count, b.win_rate * 100, b.roi_pct, clv_str, b.mean_score,
        )
    log.info(
        "  Monotonicity: ROI=%.2f, CLV=%.2f, WinRate=%.2f | Directional=%s",
        report.roi_monotonicity, report.clv_monotonicity,
        report.win_rate_monotonicity, report.is_directionally_monotonic,
    )
