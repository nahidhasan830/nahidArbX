"""LightGBM training orchestrator (Stage A → B → C → D).

Pipeline phases:
  - Stage A: Optuna HPO with purged walk-forward inner CV (hpo.py).
  - Stage B: single outer holdout — last temporal slice — for honest,
             unbiased eval of the chosen config.
  - Stage C: CPCV on the chosen config — produces the OOS prediction
             distribution used for DSR / PBO / calibration / score buckets.
  - Stage D: final fit on ALL data with the chosen config + SHAP +
             calibrator fit on Stage-C OOS predictions.

This replaces the old single-stage trainer that ran CPCV with fixed
hyperparameters. With HPO in place, DSR/PBO are now meaningful (they
deflate by the multiple-testing inflation HPO actually performed).
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Callable

import lightgbm as lgb
import numpy as np
import polars as pl
from scipy import stats
from sklearn.calibration import calibration_curve
from sklearn.metrics import accuracy_score, log_loss, roc_auc_score

from .calibration import (
    CalibrationResult,
    apply_calibration,
    fit_calibrator,
    fit_calibrator_with_validation,
    method_for_refit,
)
from .cpcv import CpcvConfig, CpcvSplit, make_cpcv_splits
from .feature_names import FEATURE_COUNT, FEATURE_NAMES
from .hpo import HpoResult, optimize
from .loader import TrainingData
from .policy import (
    POLICY_EDGE_THRESHOLD_PCT,
    policy_unit_returns,
    return_sharpe,
    compute_policy_threshold_stats,
    simple_rule_unit_returns,
)
from .scoring import (
    deflated_sharpe,
    pbo_score,
    probabilistic_sharpe,
    score_bucket_analysis,
    ScoreBucketReport,
)

log = logging.getLogger(__name__)


# ── Fixed (non-HPO-searched) LightGBM parameters ──────────────────────────
#
# HPO searches num_leaves, max_depth, learning_rate, min_child_samples,
# reg_alpha, reg_lambda. Everything below is held constant: it encodes
# domain knowledge (monotone constraints, objective, etc.) that we don't
# want HPO to perturb.
DEFAULT_LGBM_PARAMS: dict = {
    "objective": "binary",
    "metric": "binary_logloss",
    "boosting_type": "gbdt",
    # HPO-controlled — defaults used only when HPO is skipped:
    "num_leaves": 15,
    "max_depth": 5,
    "learning_rate": 0.03,
    "n_estimators": 500,
    "reg_alpha": 0.1,
    "reg_lambda": 1.0,
    # Fixed:
    "subsample": 0.8,
    "colsample_bytree": 0.6,
    "random_state": 42,
    "verbose": -1,
    "force_col_wise": True,
    # Monotone constraints for 22 features (removed ev_pct, implied_prob_gap, kelly_fraction_raw)
    "monotone_constraints": [
        0,   # 0:  sharp_true_prob (relaxed — can be non-monotonic with odds)
        0,   # 1:  soft_odds
        0,   # 2:  adjusted_soft_odds
        0,   # 3:  tick_count
        0,   # 4:  time_to_kickoff_min
        0,   # 5:  movement_pct_sharp
        0,   # 6:  movement_pct_soft
        0,   # 7:  steam_move_sharp
        0,   # 8:  steam_move_soft
        0,   # 9:  sharp_direction
        0,   # 10: soft_direction
        0,   # 11: convergence_rate
        0,   # 12: tick_velocity
        0,   # 13: provider_count
        0,   # 14: opening_sharp_odds
        0,   # 15: market_type_encoded
        0,   # 16: is_asian_line
        0,   # 17: vig_pct
        0,   # 18: competition_tier
        0,   # 19: hours_since_line_opened
        0,   # 20: sharp_soft_spread
        0,   # 21: num_markets_same_event
    ],
}

DEFAULT_CPCV_CONFIG = CpcvConfig(n_groups=10, n_test_groups=2, embargo_pct=0.01)

# Default outer holdout = last 15% of the temporal sort. Big enough to be
# informative on a few-thousand-bet corpus, small enough to keep most of
# the data in the inner CV/CPCV pipeline.
OUTER_HOLDOUT_FRACTION = 0.15

# ── Result types ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class TrainingMetrics:
    """Quality metrics from the full Stage A→D pipeline."""

    # Classification (computed on calibrated CPCV-OOS predictions)
    auc_roc: float
    accuracy: float
    log_loss_val: float
    calibration_error: float

    # Financial (CPCV-aggregated)
    oos_roi_mean: float
    oos_clv_mean: float
    policy_roi_mean: float
    policy_sample_size: int
    policy_coverage: float
    policy_edge_threshold_pct: float
    baseline_roi_mean: float = 0.0
    simple_policy_roi_mean: float = 0.0
    simple_policy_sample_size: int = 0
    simple_policy_coverage: float = 0.0
    model_vs_simple_roi_delta: float = 0.0
    policy_lower_confidence_roi_pct: float = 0.0
    policy_threshold_candidates: int = 0

    # Overfitting diagnostics — meaningful now that HPO is multi-trial.
    dsr: float = 0.0    # Deflated Sharpe Ratio (n_trials = HPO trials).
    pbo: float = 0.0    # Probability of Backtest Overfitting (CPCV path-based).

    # Stage A — HPO summary
    hpo_n_trials: int = 0
    hpo_best_objective: float = float("nan")
    hpo_per_trial_sharpe_var: float = 0.0

    # Stage B — outer-holdout honest eval (single number per metric)
    outer_holdout_n: int = 0
    outer_holdout_auc: float = float("nan")
    outer_holdout_unit_return_mean: float = float("nan")
    outer_holdout_policy_roi_pct: float = float("nan")
    outer_holdout_policy_n: int = 0

    # Training info
    n_samples: int = 0
    n_positive: int = 0
    n_negative: int = 0
    n_folds: int = 0  # CPCV folds in Stage C
    scale_pos_weight: float | None = None

    # Per-fold metrics for diagnostic logging
    per_fold_sharpes: list[float] = field(default_factory=list)

    # SHAP feature importance (feature_name → mean |SHAP|)
    feature_importance: dict[str, float] = field(default_factory=dict)

    # Score bucket calibration
    score_bucket_report: ScoreBucketReport | None = None

    # Calibration applied to runtime model output. The Node scorer reads
    # `calibration_method` + `calibration_params` from training_report and
    # reproduces the exact transform.
    calibration_method: str = "identity"
    calibration_params: dict = field(default_factory=dict)


@dataclass
class TrainingResult:
    """Complete output of the training orchestrator."""

    model: lgb.LGBMClassifier
    metrics: TrainingMetrics
    oos_predictions: np.ndarray   # calibrated, CPCV-aggregated, shape (n,)
    oos_labels: np.ndarray        # shape (n,)


# ── Public orchestrator ───────────────────────────────────────────────────


def train(
    data: TrainingData,
    *,
    lgbm_params: dict | None = None,
    cpcv_config: CpcvConfig | None = None,
    run_hpo: bool = True,
    hpo_trials: int = 50,
    hpo_timeout_seconds: int | None = 600,
    calibration_method: str = "auto",
    progress_callback: Callable[[str, str, int], None] | None = None,
) -> TrainingResult:
    """Run the full Stage A→D pipeline.

    Args:
        data: full training corpus (already chronologically sorted by loader).
        lgbm_params: explicit override. When provided, HPO is skipped and
            these params are used for stages B, C, D — useful for unit tests.
        cpcv_config: override the default 10-group / 2-test CPCV setup.
        run_hpo: master switch. False = skip Stage A (uses defaults).
        hpo_trials: Optuna budget. 50 is the practical knee for our
            6-dim search space.
        hpo_timeout_seconds: hard wall-clock cap. None disables.
        calibration_method: "auto" (size-based) | "platt" | "beta" |
            "isotonic" | "identity".
    """
    if data.n_samples == 0:
        raise ValueError("Cannot train on empty dataset")

    base_params = {**DEFAULT_LGBM_PARAMS}
    cfg = cpcv_config or DEFAULT_CPCV_CONFIG

    def progress(stage: str, message: str, estimated_ms: int = 0) -> None:
        if progress_callback is None:
            return
        try:
            progress_callback(stage, message, estimated_ms)
        except Exception as exc:
            log.warning("Progress callback failed: %s", exc)

    # ── Stage A: HPO ──────────────────────────────────────────────────
    progress("hpo", f"Starting HPO: {hpo_trials} trials", 300_000)
    hpo_result = _stage_a_hpo(
        data,
        base_params=base_params,
        run_hpo=run_hpo and lgbm_params is None,
        n_trials=hpo_trials,
        timeout_seconds=hpo_timeout_seconds,
        progress_callback=lambda i, total, value: progress(
            "hpo",
            f"HPO trial {i}/{total} — objective {value:.6f}",
            300_000,
        ),
    )

    chosen_params: dict = (
        {**base_params, **lgbm_params}
        if lgbm_params is not None
        else hpo_result.best_params
    )
    if "min_child_samples" not in chosen_params:
        chosen_params["min_child_samples"] = _adaptive_min_child_samples(data.n_samples)

    log.info(
        "Stage A complete: n_trials=%d, best_objective=%.6f, chosen_params=%s",
        hpo_result.n_trials, hpo_result.best_value,
        {k: chosen_params.get(k) for k in (
            "num_leaves", "max_depth", "learning_rate",
            "min_child_samples", "reg_alpha", "reg_lambda",
        )},
    )
    best_objective = (
        f"{hpo_result.best_value:.6f}"
        if not math.isnan(hpo_result.best_value)
        else "baseline params"
    )
    progress("hpo", f"HPO complete — best objective {best_objective}", 20_000)

    # ── Stage B: outer holdout ────────────────────────────────────────
    progress("holdout", "Running outer holdout validation", 60_000)
    outer = _stage_b_outer_holdout(data, chosen_params)
    log.info(
        "Stage B complete: holdout n=%d AUC=%.4f unit_return=%.4f policy_n=%d policy_roi=%.2f%%",
        outer["n"], outer["auc"], outer["unit_return_mean"],
        outer["policy_n"], outer["policy_roi_pct"],
    )
    progress(
        "holdout",
        f"Holdout AUC: {outer['auc']:.4f} ({outer['n']} samples)",
        60_000,
    )

    # ── Stage C: CPCV risk certification ──────────────────────────────
    progress("cpcv", "Starting CPCV risk certification", 120_000)
    cpcv_out = _stage_c_cpcv(data, chosen_params, cfg, progress=progress)
    log.info(
        "Stage C complete: %d folds, mean fold-Sharpe=%.4f, mean fold-ROI=%.2f%%",
        cpcv_out["n_folds"], cpcv_out["mean_sharpe"], cpcv_out["mean_roi"],
    )
    progress(
        "cpcv",
        f"CPCV complete — Sharpe {cpcv_out['mean_sharpe']:.3f}, ROI {cpcv_out['mean_roi']:.2f}%",
        30_000,
    )

    # ── Calibration on CPCV OOS predictions ───────────────────────────
    valid_mask = cpcv_out["valid_mask"]
    raw_oos_valid = cpcv_out["oos_preds"][valid_mask]
    labels_valid = data.labels[valid_mask]

    # Fit a calibration transform for runtime on all CPCV-OOS predictions, but
    # evaluate calibration-sensitive metrics on a held-out tail when enough
    # data exists. This avoids reporting a calibration error measured on the
    # exact labels used to fit a flexible calibrator.
    cal_fit_idx, cal_eval_idx = _split_calibration_fit_eval(labels_valid)
    calibration_for_metrics = fit_calibrator_with_validation(
        raw_oos_valid[cal_fit_idx],
        labels_valid[cal_fit_idx],
        raw_oos_valid[cal_eval_idx],
        labels_valid[cal_eval_idx],
        method=calibration_method,
    )
    calibrated_eval = apply_calibration(
        raw_oos_valid[cal_eval_idx],
        calibration_for_metrics,
    )

    calibration = fit_calibrator(
        raw_oos_valid,
        labels_valid,
        method=method_for_refit(calibration_for_metrics),
    )
    calibrated_oos_valid = apply_calibration(raw_oos_valid, calibration)
    calibrated_oos_full = cpcv_out["oos_preds"].copy()
    calibrated_oos_full[valid_mask] = calibrated_oos_valid

    # ── Aggregate metrics ─────────────────────────────────────────────
    auc, acc, ll, ece = _classification_metrics(
        labels_valid[cal_eval_idx],
        calibrated_eval,
    )

    clv_col = data.metadata["clv_pct"].to_numpy().astype(np.float64)
    clv_valid = clv_col[valid_mask]
    finite_clv = clv_valid[np.isfinite(clv_valid)]
    oos_clv = float(finite_clv.mean()) if finite_clv.size > 0 else 0.0

    # Score-bucket diagnostics on calibrated CPCV-OOS preds.
    if "unit_return" in data.metadata.columns:
        ur_arr = data.metadata["unit_return"].to_numpy().astype(np.float64)
        pnl_valid = np.nan_to_num(ur_arr[valid_mask], nan=0.0)
    else:
        pnl_arr = data.metadata["pnl"].to_numpy().astype(np.float64)
        pnl_valid = np.nan_to_num(pnl_arr[valid_mask], nan=0.0)

    valid_features = data.features[valid_mask]
    threshold_stats = compute_policy_threshold_stats(
        calibrated_oos_valid,
        valid_features,
        pnl_valid,
    )
    policy = _evaluate_policy(
        calibrated_oos_valid,
        features=valid_features,
        metadata=data.metadata.filter(valid_mask.tolist()),
        edge_threshold_pct=threshold_stats.threshold_pct,
    )
    simple_policy = _evaluate_simple_policy(
        features=data.features[valid_mask],
        unit_returns=pnl_valid,
    )
    baseline_roi = float(pnl_valid.mean() * 100.0) if pnl_valid.size > 0 else 0.0
    model_vs_simple_delta = (
        policy.roi_pct - simple_policy.roi_pct
        if simple_policy.sample_size > 0
        else 0.0
    )

    clv_for_buckets = clv_valid if finite_clv.size > 0 else None
    bucket_report = score_bucket_analysis(
        policy.edge_scores_pct, labels_valid, pnl_valid, clv_for_buckets,
    )
    _log_bucket_report(bucket_report)

    # DSR — now meaningful: n_trials = number of HPO configs evaluated, and
    # n = number of policy bets rather than every baseline detection.
    cpcv_policy_at_threshold = _evaluate_cpcv_policy_threshold(
        raw_preds=cpcv_out["raw_fold_preds"],
        fold_features=cpcv_out["fold_features"],
        fold_unit_returns=cpcv_out["fold_unit_returns"],
        calibration=calibration,
        edge_threshold_pct=threshold_stats.threshold_pct,
    )
    outer_policy_at_threshold = _evaluate_outer_holdout_policy_threshold(
        outer=outer,
        calibration=calibration,
        edge_threshold_pct=threshold_stats.threshold_pct,
    )
    mean_cpcv_sharpe = cpcv_policy_at_threshold["mean_sharpe"]
    # Fixed threshold (no search) — n_trials_for_dsr is just HPO trials
    n_trials_for_dsr = max(hpo_result.n_trials, 1)
    sharpe_var_across_trials = (
        float(np.var(hpo_result.per_trial_sharpes, ddof=1))
        if len(hpo_result.per_trial_sharpes) > 1
        else 0.0
    )
    skew_val, kurt_val = _safe_skew_kurt(np.asarray(cpcv_policy_at_threshold["per_fold_sharpes"]))
    dsr_n = max(policy.sample_size, 2)

    if n_trials_for_dsr >= 2 and sharpe_var_across_trials > 0:
        dsr = deflated_sharpe(
            mean_cpcv_sharpe,
            n=dsr_n,
            n_trials=n_trials_for_dsr,
            sharpe_variance_across_trials=sharpe_var_across_trials,
            skew=skew_val,
            kurtosis=kurt_val,
        )
    else:
        # Single-trial fallback: PSR vs zero (no multiple-testing penalty).
        dsr = probabilistic_sharpe(
            mean_cpcv_sharpe,
            n=dsr_n,
            skew=skew_val,
            kurtosis=kurt_val,
        )

    # PBO — CPCV-paths based, single-config.
    pbo_val = pbo_score(
        [cpcv_policy_at_threshold["per_fold_rois"]],
        n_subsamples=200,
        seed=42,
    )

    # ── Stage D: final fit on ALL data + SHAP ─────────────────────────
    log.info("Stage D: training final model on all %d samples", data.n_samples)
    progress("final", f"Fitting final model on {data.n_samples} samples", 10_000)
    final_model = lgb.LGBMClassifier(**chosen_params)
    final_model.fit(
        data.features, data.labels, sample_weight=data.sample_weights,
    )

    feature_importance = _compute_shap_importance(final_model, data.features)

    # ── Build the TrainingMetrics dataclass ───────────────────────────
    metrics = TrainingMetrics(
        auc_roc=round(auc, 4),
        accuracy=round(acc, 4),
        log_loss_val=round(ll, 6),
        calibration_error=round(ece, 6),
        oos_roi_mean=round(cpcv_policy_at_threshold["mean_roi"], 4),
        oos_clv_mean=round(oos_clv, 4),
        policy_roi_mean=round(policy.roi_pct, 4),
        policy_sample_size=policy.sample_size,
        policy_coverage=round(policy.coverage, 4),
        policy_edge_threshold_pct=round(threshold_stats.threshold_pct, 4),
        baseline_roi_mean=round(baseline_roi, 4),
        simple_policy_roi_mean=round(simple_policy.roi_pct, 4),
        simple_policy_sample_size=simple_policy.sample_size,
        simple_policy_coverage=round(simple_policy.coverage, 4),
        model_vs_simple_roi_delta=round(model_vs_simple_delta, 4),
        dsr=round(dsr, 4),
        pbo=round(pbo_val, 4),
        hpo_n_trials=hpo_result.n_trials,
        hpo_best_objective=round(hpo_result.best_value, 6)
        if not math.isnan(hpo_result.best_value) else float("nan"),
        hpo_per_trial_sharpe_var=round(sharpe_var_across_trials, 6),
        outer_holdout_n=outer["n"],
        outer_holdout_auc=round(outer["auc"], 4),
        outer_holdout_unit_return_mean=round(outer["unit_return_mean"], 6),
        outer_holdout_policy_roi_pct=round(outer_policy_at_threshold["policy_roi_pct"], 4),
        outer_holdout_policy_n=outer_policy_at_threshold["policy_n"],
        n_samples=data.n_samples,
        n_positive=int(data.labels.sum()),
        n_negative=int((data.labels == 0).sum()),
        n_folds=cpcv_out["n_folds"],
        scale_pos_weight=data.scale_pos_weight,
        per_fold_sharpes=[round(s, 4) for s in cpcv_policy_at_threshold["per_fold_sharpes"]],
        feature_importance=feature_importance,
        score_bucket_report=bucket_report,
        calibration_method=calibration.method,
        calibration_params=calibration.params,
    )

    log.info(
        "Training complete: AUC=%.4f DSR=%.4f PBO=%.4f ROI=%.2f%% "
        "policyROI=%.2f%% policyN=%d simpleROI=%.2f%% simpleN=%d "
        "outerAUC=%.4f outerN=%d cal=%s",
        metrics.auc_roc, metrics.dsr, metrics.pbo, metrics.oos_roi_mean,
        metrics.policy_roi_mean, metrics.policy_sample_size,
        metrics.simple_policy_roi_mean, metrics.simple_policy_sample_size,
        metrics.outer_holdout_auc, metrics.outer_holdout_n,
        metrics.calibration_method,
    )

    return TrainingResult(
        model=final_model,
        metrics=metrics,
        oos_predictions=calibrated_oos_full,
        oos_labels=data.labels,
    )


# ── Stage A ───────────────────────────────────────────────────────────────


def _stage_a_hpo(
    data: TrainingData,
    *,
    base_params: dict,
    run_hpo: bool,
    n_trials: int,
    timeout_seconds: int | None,
    progress_callback: Callable[[int, int, float], None] | None = None,
) -> HpoResult:
    if not run_hpo:
        log.info("Stage A skipped (run_hpo=False or explicit lgbm_params provided)")
        return HpoResult(
            best_params=dict(base_params),
            best_value=float("nan"),
            n_trials=0,
        )
    return optimize(
        data,
        base_params=base_params,
        n_trials=n_trials,
        timeout_seconds=timeout_seconds,
        progress_callback=progress_callback,
    )


# ── Stage B ───────────────────────────────────────────────────────────────


def _stage_b_outer_holdout(data: TrainingData, params: dict) -> dict:
    """Train on first (1-OUTER_HOLDOUT_FRACTION) of data, eval on the tail."""
    n = data.n_samples
    holdout_size = max(20, int(round(n * OUTER_HOLDOUT_FRACTION)))
    if holdout_size >= n - 20:
        log.warning("Outer holdout too small (n=%d) — returning placeholder", n)
        return {
            "n": 0, "auc": float("nan"), "unit_return_mean": float("nan"),
            "policy_roi_pct": float("nan"), "policy_n": 0,
            "raw_preds": np.empty(0, dtype=np.float64),
            "features": np.empty((0, data.features.shape[1]), dtype=np.float32),
            "unit_returns": np.empty(0, dtype=np.float64),
        }

    train_idx = np.arange(n - holdout_size, dtype=np.int64)
    test_idx = np.arange(n - holdout_size, n, dtype=np.int64)

    X_train, y_train = data.features[train_idx], data.labels[train_idx]
    w_train = data.sample_weights[train_idx] if data.sample_weights is not None else None

    model = lgb.LGBMClassifier(**params)
    model.fit(X_train, y_train, sample_weight=w_train,
              callbacks=[lgb.log_evaluation(period=0)])

    X_test, y_test = data.features[test_idx], data.labels[test_idx]
    raw_preds = model.predict_proba(X_test)[:, 1]

    try:
        auc = float(roc_auc_score(y_test, raw_preds))
    except ValueError:
        auc = 0.5

    test_meta = data.metadata[test_idx.tolist()]
    if "unit_return" in test_meta.columns:
        unit_returns = test_meta["unit_return"].to_numpy().astype(np.float64)
    else:
        unit_returns = test_meta["pnl"].to_numpy().astype(np.float64)
    unit_returns = np.nan_to_num(unit_returns, nan=0.0)
    unit_return_mean = float(unit_returns.mean()) if unit_returns.size > 0 else 0.0

    # Policy eval on the holdout: what fraction would be auto-placed?
    test_features = X_test
    selected_returns, _edge_scores, policy_mask = policy_unit_returns(
        raw_preds,
        test_features,
        unit_returns,
        edge_threshold_pct=POLICY_EDGE_THRESHOLD_PCT,
    )
    policy_n = int(policy_mask.sum())
    policy_roi_pct = (
        float(selected_returns.mean() * 100.0) if policy_n > 0 else float("nan")
    )

    return {
        "n": int(test_idx.size),
        "auc": auc,
        "unit_return_mean": unit_return_mean,
        "policy_roi_pct": policy_roi_pct,
        "policy_n": policy_n,
        "raw_preds": raw_preds,
        "features": test_features,
        "unit_returns": unit_returns,
    }


# ── Stage C ───────────────────────────────────────────────────────────────


def _stage_c_cpcv(
    data: TrainingData,
    params: dict,
    cfg: CpcvConfig,
    progress: Callable[[str, str, int], None] | None = None,
) -> dict:
    """CPCV risk certification with the chosen hyperparameters."""
    splitter_df = pl.DataFrame({
        "event_id": data.metadata["event_id"].to_list(),
    })
    splits = make_cpcv_splits(splitter_df, cfg)
    n_folds = len(splits)

    n = data.n_samples
    oos_pred_sum = np.zeros(n, dtype=np.float64)
    oos_pred_count = np.zeros(n, dtype=np.int32)
    per_fold_sharpes: list[float] = []
    per_fold_rois: list[float] = []
    raw_fold_preds: list[np.ndarray] = []
    fold_features: list[np.ndarray] = []
    fold_unit_returns: list[np.ndarray] = []

    X = data.features
    y = data.labels
    w = data.sample_weights

    for split in splits:
        train_idx = split.train_indices
        test_idx = split.test_indices
        if len(train_idx) < 10 or len(test_idx) < 5:
            continue

        fit_idx, val_idx = _split_train_validation(train_idx, y)
        if len(fit_idx) < 10:
            continue

        X_train, y_train = X[fit_idx], y[fit_idx]
        w_train = w[fit_idx] if w is not None else None
        X_test = X[test_idx]

        model = lgb.LGBMClassifier(**params)
        fit_kwargs: dict = {
            "sample_weight": w_train,
            "callbacks": [lgb.log_evaluation(period=0)],
        }
        if len(val_idx) >= 5:
            X_val, y_val = X[val_idx], y[val_idx]
            fit_kwargs["eval_set"] = [(X_val, y_val)]
            fit_kwargs["eval_metric"] = "binary_logloss"
            fit_kwargs["callbacks"] = [
                lgb.early_stopping(stopping_rounds=50, first_metric_only=True, verbose=False),
                lgb.log_evaluation(period=0),
            ]
        model.fit(X_train, y_train, **fit_kwargs)

        preds = model.predict_proba(X_test)[:, 1]
        oos_pred_sum[test_idx] += preds
        oos_pred_count[test_idx] += 1

        fold_meta = data.metadata[test_idx.tolist()]
        if "unit_return" in fold_meta.columns:
            unit_returns = fold_meta["unit_return"].to_numpy().astype(np.float64)
        else:
            unit_returns = fold_meta["pnl"].to_numpy().astype(np.float64)
        unit_returns = np.nan_to_num(unit_returns, nan=0.0)
        raw_fold_preds.append(preds)
        fold_features.append(X_test)
        fold_unit_returns.append(unit_returns)

        selected_returns, _edges, _policy_mask = policy_unit_returns(
            preds, X_test, unit_returns,
        )
        sharpe = return_sharpe(selected_returns)
        per_fold_sharpes.append(sharpe)
        per_fold_rois.append(
            float(selected_returns.mean() * 100.0)
            if selected_returns.size > 0
            else 0.0
        )
        fold_number = split.path_index + 1
        if progress is not None and (
            fold_number == 1 or fold_number % 5 == 0 or fold_number == n_folds
        ):
            progress(
                "cpcv",
                f"CPCV fold {fold_number}/{n_folds} — Sharpe {sharpe:.3f}",
                120_000,
            )

    oos_preds = np.full(n, np.nan, dtype=np.float64)
    predicted_mask = oos_pred_count > 0
    oos_preds[predicted_mask] = oos_pred_sum[predicted_mask] / oos_pred_count[predicted_mask]
    valid_mask = ~np.isnan(oos_preds)

    mean_sharpe = float(np.mean(per_fold_sharpes)) if per_fold_sharpes else 0.0
    mean_roi = float(np.mean(per_fold_rois)) if per_fold_rois else 0.0

    return {
        "oos_preds": oos_preds,
        "valid_mask": valid_mask,
        "per_fold_sharpes": per_fold_sharpes,
        "per_fold_rois": per_fold_rois,
        "mean_sharpe": mean_sharpe,
        "mean_roi": mean_roi,
        "n_folds": n_folds,
        "raw_fold_preds": raw_fold_preds,
        "fold_features": fold_features,
        "fold_unit_returns": fold_unit_returns,
    }


# ── Helpers ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PolicyEvaluation:
    edge_scores_pct: np.ndarray
    roi_pct: float
    sample_size: int
    coverage: float


def _classification_metrics(
    labels: np.ndarray, calibrated_probs: np.ndarray,
) -> tuple[float, float, float, float]:
    if labels.size == 0:
        return 0.5, 0.0, 0.0, 0.0
    unique_labels = np.unique(labels)
    try:
        auc = (
            float(roc_auc_score(labels, calibrated_probs))
            if unique_labels.size >= 2
            else 0.5
        )
    except ValueError:
        auc = 0.5
    acc = float(accuracy_score(labels, (calibrated_probs > 0.5).astype(int)))
    try:
        ll = float(
            log_loss(
                labels,
                np.clip(calibrated_probs, 1e-7, 1 - 1e-7),
                labels=[0, 1],
            )
        )
    except ValueError:
        ll = 0.0
    ece = _expected_calibration_error(labels, calibrated_probs)
    return auc, acc, ll, ece


def _split_calibration_fit_eval(labels: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Chronological split for honest calibration metrics.

    The final runtime calibrator is fit on all OOS predictions, but model-gate
    metrics should not score a calibrator on the same rows it learned from.
    For small or single-class data, fall back to all rows to avoid throwing away
    the only usable signal.
    """
    n = labels.size
    all_idx = np.arange(n, dtype=np.int64)
    if n < 80 or np.unique(labels).size < 2:
        return all_idx, all_idx

    split = int(round(n * 0.7))
    fit_idx = all_idx[:split]
    eval_idx = all_idx[split:]
    if fit_idx.size < 20 or eval_idx.size < 20:
        return all_idx, all_idx
    if np.unique(labels[fit_idx]).size < 2 or np.unique(labels[eval_idx]).size < 2:
        return all_idx, all_idx
    return fit_idx, eval_idx


def _safe_skew_kurt(arr: np.ndarray) -> tuple[float, float]:
    if arr.size <= 2:
        return 0.0, 3.0
    sk = float(stats.skew(arr))
    kt = float(stats.kurtosis(arr, fisher=False)) if arr.size > 3 else 3.0
    if math.isnan(sk):
        sk = 0.0
    if math.isnan(kt):
        kt = 3.0
    return sk, kt


def _split_train_validation(
    train_idx: np.ndarray, y: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Chronological inner split for early stopping without touching test rows."""
    if len(train_idx) < 20:
        return train_idx, np.array([], dtype=np.int64)
    val_size = max(5, int(round(len(train_idx) * 0.2)))
    val_idx = train_idx[-val_size:]
    fit_idx = train_idx[:-val_size]
    if len(np.unique(y[val_idx])) < 2 or len(np.unique(y[fit_idx])) < 2:
        return train_idx, np.array([], dtype=np.int64)
    return fit_idx, val_idx


def _evaluate_policy(
    calibrated_probs: np.ndarray,
    *,
    features: np.ndarray,
    metadata,
    edge_threshold_pct: float = POLICY_EDGE_THRESHOLD_PCT,
) -> PolicyEvaluation:
    if len(calibrated_probs) == 0:
        return PolicyEvaluation(
            edge_scores_pct=np.empty(0, dtype=np.float64),
            roi_pct=0.0,
            sample_size=0,
            coverage=0.0,
        )

    if "unit_return" in metadata.columns:
        unit_returns = metadata["unit_return"].to_numpy().astype(np.float64)
    else:
        unit_returns = metadata["pnl"].to_numpy().astype(np.float64)
    unit_returns = np.nan_to_num(unit_returns, nan=0.0)

    selected_returns, edge_scores_pct, policy_mask = policy_unit_returns(
        calibrated_probs,
        features,
        unit_returns,
        edge_threshold_pct=edge_threshold_pct,
    )
    sample_size = int(policy_mask.sum())
    roi_pct = float(selected_returns.mean() * 100.0) if sample_size > 0 else 0.0
    coverage = float(sample_size / len(calibrated_probs)) if len(calibrated_probs) > 0 else 0.0

    return PolicyEvaluation(
        edge_scores_pct=edge_scores_pct,
        roi_pct=roi_pct,
        sample_size=sample_size,
        coverage=coverage,
    )


def _evaluate_simple_policy(
    *,
    features: np.ndarray,
    unit_returns: np.ndarray,
) -> PolicyEvaluation:
    selected_returns, mask = simple_rule_unit_returns(features, unit_returns)
    sample_size = int(mask.sum())
    roi_pct = float(selected_returns.mean() * 100.0) if sample_size > 0 else 0.0
    coverage = float(sample_size / len(unit_returns)) if len(unit_returns) > 0 else 0.0
    return PolicyEvaluation(
        edge_scores_pct=np.empty(0, dtype=np.float64),
        roi_pct=roi_pct,
        sample_size=sample_size,
        coverage=coverage,
    )


def _evaluate_cpcv_policy_threshold(
    *,
    raw_preds: list[np.ndarray],
    fold_features: list[np.ndarray],
    fold_unit_returns: list[np.ndarray],
    calibration: CalibrationResult,
    edge_threshold_pct: float,
) -> dict:
    """Re-score CPCV fold returns with the selected runtime policy threshold."""
    per_fold_sharpes: list[float] = []
    per_fold_rois: list[float] = []

    for preds, features, unit_returns in zip(
        raw_preds,
        fold_features,
        fold_unit_returns,
    ):
        calibrated = apply_calibration(preds, calibration)
        selected_returns, _edges, _policy_mask = policy_unit_returns(
            calibrated,
            features,
            unit_returns,
            edge_threshold_pct=edge_threshold_pct,
        )
        per_fold_sharpes.append(return_sharpe(selected_returns))
        per_fold_rois.append(
            float(selected_returns.mean() * 100.0)
            if selected_returns.size > 0
            else 0.0
        )

    return {
        "per_fold_sharpes": per_fold_sharpes,
        "per_fold_rois": per_fold_rois,
        "mean_sharpe": float(np.mean(per_fold_sharpes)) if per_fold_sharpes else 0.0,
        "mean_roi": float(np.mean(per_fold_rois)) if per_fold_rois else 0.0,
    }


def _evaluate_outer_holdout_policy_threshold(
    *,
    outer: dict,
    calibration: CalibrationResult,
    edge_threshold_pct: float,
) -> dict:
    """Re-score the outer holdout with the deployable calibrated policy."""
    raw_preds = outer.get("raw_preds")
    features = outer.get("features")
    unit_returns = outer.get("unit_returns")
    if (
        not isinstance(raw_preds, np.ndarray)
        or not isinstance(features, np.ndarray)
        or not isinstance(unit_returns, np.ndarray)
        or raw_preds.size == 0
    ):
        return {"policy_roi_pct": float("nan"), "policy_n": 0}

    calibrated = apply_calibration(raw_preds, calibration)
    selected_returns, _edges, policy_mask = policy_unit_returns(
        calibrated,
        features,
        unit_returns,
        edge_threshold_pct=edge_threshold_pct,
    )
    policy_n = int(policy_mask.sum())
    return {
        "policy_roi_pct": (
            float(selected_returns.mean() * 100.0)
            if selected_returns.size > 0
            else float("nan")
        ),
        "policy_n": policy_n,
    }


def _expected_calibration_error(
    y_true: np.ndarray, y_prob: np.ndarray, n_bins: int = 10,
) -> float:
    try:
        fraction_of_positives, mean_predicted = calibration_curve(
            y_true, y_prob, n_bins=n_bins, strategy="uniform",
        )
    except ValueError:
        return 0.0

    bin_edges = np.linspace(0, 1, n_bins + 1)
    bin_indices = np.digitize(y_prob, bin_edges[1:-1])
    bin_counts = np.array([np.sum(bin_indices == i) for i in range(n_bins)])
    n_returned = len(fraction_of_positives)
    if n_returned == 0:
        return 0.0
    non_empty = bin_counts[bin_counts > 0][:n_returned]
    weights = non_empty / non_empty.sum() if non_empty.sum() > 0 else np.ones(n_returned)
    return float(np.sum(weights * np.abs(fraction_of_positives - mean_predicted)))


def _compute_shap_importance(
    model: lgb.LGBMClassifier,
    X: np.ndarray,
    max_samples: int = 500,
) -> dict[str, float]:
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
        if isinstance(shap_values, list):
            shap_values = shap_values[1]
        mean_abs = np.abs(shap_values).mean(axis=0)
        return {
            FEATURE_NAMES[i]: round(float(mean_abs[i]), 6)
            for i in range(FEATURE_COUNT)
        }
    except Exception as e:
        log.warning("SHAP computation failed: %s", e)
        return {}


def _adaptive_min_child_samples(n_samples: int) -> int:
    if n_samples <= 200:
        return 5
    if n_samples >= 2000:
        return 20
    return int(5 + (n_samples - 200) / (2000 - 200) * 15)


def _log_bucket_report(report: ScoreBucketReport) -> None:
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


# ── Feature ablation ───────────────────────────────────────────────────


def run_ablation(
    data: TrainingData,
    *,
    base_params: dict | None = None,
    n_trials: int = 10,
    comparison_metric: str = "dsr",
) -> list[dict]:
    """Train models with each feature held out, compare against full model.

    Returns a list of {feature_name, full_model_value, ablated_value, delta,
    delta_pct} sorted by delta desc (most impactful features first).

    Features whose removal causes a large drop in the target metric are
    causal candidates. Features with near-zero (or positive!) delta are
    candidates for removal — they add noise without signal.

    Args:
        data: full training corpus.
        base_params: explicit LGBM params to use (HPO is skipped per model
            for speed — use a previously-optimised config).
        n_trials: HPO budget per model (reduced from default 50).
        comparison_metric: "dsr" | "auc" | "roi".
    """
    if data.n_samples < 200:
        log.warning("Ablation skipped: insufficient samples (%d)", data.n_samples)
        return []

    params = base_params or DEFAULT_LGBM_PARAMS.copy()
    if "min_child_samples" not in params:
        params["min_child_samples"] = _adaptive_min_child_samples(data.n_samples)

    log.info("Feature ablation: running full model baseline")
    from .scoring import deflated_sharpe, probabilistic_sharpe

    # Full model baseline (Stage C CPCV only, no HPO)
    full_result = _stage_c_cpcv(data, params, DEFAULT_CPCV_CONFIG)
    full_sharpe = full_result["mean_sharpe"]
    full_roi = full_result["mean_roi"]
    full_auc = _quick_auc(data, params)

    results: list[dict] = []

    for feat_idx in range(FEATURE_COUNT):
        feat_name = FEATURE_NAMES[feat_idx]
        log.info("Ablation: holding out feature %d/%d: %s", feat_idx + 1, FEATURE_COUNT, feat_name)

        # Mask out one feature
        ablated_features = data.features.copy()
        ablated_features[:, feat_idx] = 0.0

        ablated_data = TrainingData(
            features=ablated_features,
            labels=data.labels,
            feature_names=list(FEATURE_NAMES),
            metadata=data.metadata,
            n_samples=data.n_samples,
            sample_weights=data.sample_weights,
            scale_pos_weight=data.scale_pos_weight,
        )

        try:
            ablated_cpcv = _stage_c_cpcv(ablated_data, params, DEFAULT_CPCV_CONFIG)
            ablated_sharpe = ablated_cpcv["mean_sharpe"]
            ablated_roi = ablated_cpcv["mean_roi"]
            ablated_auc = _quick_auc(ablated_data, params)
        except Exception as e:
            log.warning("Ablation for %s failed: %s", feat_name, e)
            results.append({
                "feature_name": feat_name,
                "feature_index": feat_idx,
                "full_dsr": round(full_sharpe, 4),
                "ablated_dsr": float("nan"),
                "dsr_delta": float("nan"),
                "full_roi": round(full_roi, 4),
                "ablated_roi": float("nan"),
                "roi_delta": float("nan"),
                "full_auc": round(full_auc, 4),
                "ablated_auc": float("nan"),
                "auc_delta": float("nan"),
            })
            continue

        results.append({
            "feature_name": feat_name,
            "feature_index": feat_idx,
            "full_dsr": round(full_sharpe, 4),
            "ablated_dsr": round(ablated_sharpe, 4),
            "dsr_delta": round(full_sharpe - ablated_sharpe, 4),
            "full_roi": round(full_roi, 4),
            "ablated_roi": round(ablated_roi, 4),
            "roi_delta": round(full_roi - ablated_roi, 4),
            "full_auc": round(full_auc, 4),
            "ablated_auc": round(ablated_auc, 4),
            "auc_delta": round(full_auc - ablated_auc, 4),
        })

    # Sort by DSR delta (most impactful first)
    results.sort(key=lambda r: r.get("dsr_delta", 0) or 0, reverse=True)

    log.info(
        "Ablation complete: %d features tested. Top-5 by DSR impact: %s",
        len(results),
        ", ".join(
            f"{r['feature_name']}={r['dsr_delta']:.4f}"
            for r in results[:5]
        ),
    )

    # Flag redundant features (negative delta = model improved without them)
    redundant = [r for r in results if (r.get("dsr_delta") or 0) <= 0]
    if redundant:
        log.warning(
            "Potential redundant features (DSR unchanged or improved when removed): %s",
            ", ".join(r["feature_name"] for r in redundant),
        )

    return results


def _quick_auc(data: TrainingData, params: dict) -> float:
    """Quick AUC estimate via single train/test split (not CPCV)."""
    import lightgbm as lgb
    from sklearn.metrics import roc_auc_score

    n = data.n_samples
    split = max(50, int(n * 0.8))
    if split >= n - 10:
        return 0.5

    X_train, y_train = data.features[:split], data.labels[:split]
    X_test, y_test = data.features[split:], data.labels[split:]

    model = lgb.LGBMClassifier(**params)
    model.fit(X_train, y_train, verbose=-1)
    try:
        return float(roc_auc_score(y_test, model.predict_proba(X_test)[:, 1]))
    except ValueError:
        return 0.5
