#!/usr/bin/env python3
"""Observer script — runs training pipeline locally with deep diagnostics.

Dumps:
  - Data composition (example types, outcomes, label balance)
  - Feature distribution summary
  - Per-bucket detailed breakdown with PnL histograms
  - Monotonicity analysis: which adjacent pairs break monotonicity
  - Score distribution analysis
  - PnL signal vs. score correlation

Usage:
    cd services/optimizer
    uv run python ../../scripts/observe-training.py
"""

from __future__ import annotations

import json
import logging
import math
import os
import sys

# Add optimizer package to path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
OPTIMIZER_DIR = os.path.join(REPO_ROOT, "services", "optimizer")
sys.path.insert(0, OPTIMIZER_DIR)

import numpy as np

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("observe-training")


def main() -> None:
    log.info("=" * 72)
    log.info("TRAINING OBSERVER — Deep Diagnostics")
    log.info("=" * 72)

    # ── Load data ──────────────────────────────────────────────────────
    from app.db import open_session
    from app.loader import load_best_available, load_from_training_examples, load_training_data

    session = open_session()
    try:
        # Show what each source provides
        te_data = load_from_training_examples(session)
        bets_data = load_training_data(session)
        best_data = load_best_available(session)
    finally:
        session.close()

    log.info("")
    log.info("═══ DATA SOURCE DIAGNOSTICS ═══")
    log.info("  training_examples: %d samples", te_data.n_samples if te_data else 0)
    log.info("  bets table:        %d samples", bets_data.n_samples)
    log.info("  best_available:    %d samples (used for training)", best_data.n_samples)

    data = best_data

    # ── Label & outcome breakdown ──────────────────────────────────────
    log.info("")
    log.info("═══ LABEL & OUTCOME BREAKDOWN ═══")
    n_pos = int(data.labels.sum())
    n_neg = int((data.labels == 0).sum())
    log.info("  Positive (won/half_won): %d (%.1f%%)", n_pos, n_pos / data.n_samples * 100)
    log.info("  Negative (lost/half_lost): %d (%.1f%%)", n_neg, n_neg / data.n_samples * 100)
    log.info("  scale_pos_weight: %s", data.scale_pos_weight)

    if "outcome" in data.metadata.columns:
        outcome_counts = data.metadata["outcome"].value_counts()
        log.info("  Outcome distribution:")
        for row in outcome_counts.iter_rows():
            log.info("    %s: %d", row[0], row[1])

    if "example_type" in data.metadata.columns:
        type_counts = data.metadata["example_type"].value_counts()
        log.info("  Example type distribution:")
        for row in type_counts.iter_rows():
            log.info("    %s: %d", row[0] or "N/A", row[1])

    # ── Sample weights ─────────────────────────────────────────────────
    if data.sample_weights is not None:
        sw = data.sample_weights
        log.info("")
        log.info("═══ SAMPLE WEIGHTS ═══")
        log.info("  min=%.3f  max=%.3f  mean=%.3f  std=%.3f",
                 sw.min(), sw.max(), sw.mean(), sw.std())
        unique_weights = np.unique(sw)
        if len(unique_weights) < 20:
            for w in unique_weights:
                cnt = (sw == w).sum()
                log.info("    weight=%.3f → %d samples (%.1f%%)", w, cnt, cnt / len(sw) * 100)

    # ── PnL analysis ───────────────────────────────────────────────────
    pnl_arr = data.metadata["pnl"].to_numpy().astype(np.float64)
    pnl_arr = np.nan_to_num(pnl_arr, nan=0.0)
    log.info("")
    log.info("═══ PNL ANALYSIS ═══")
    log.info("  min=%.3f  max=%.3f  mean=%.3f  median=%.3f",
             pnl_arr.min(), pnl_arr.max(), pnl_arr.mean(), np.median(pnl_arr))
    log.info("  positive PnL: %d (%.1f%%)",
             (pnl_arr > 0).sum(), (pnl_arr > 0).sum() / len(pnl_arr) * 100)
    log.info("  negative PnL: %d (%.1f%%)",
             (pnl_arr < 0).sum(), (pnl_arr < 0).sum() / len(pnl_arr) * 100)
    log.info("  zero PnL: %d (%.1f%%)",
             (pnl_arr == 0).sum(), (pnl_arr == 0).sum() / len(pnl_arr) * 100)

    # Unit return analysis
    if "unit_return" in data.metadata.columns:
        ur_arr = data.metadata["unit_return"].to_numpy().astype(np.float64)
        ur_arr = np.nan_to_num(ur_arr, nan=0.0)
        log.info("")
        log.info("═══ UNIT RETURN ANALYSIS ═══")
        log.info("  min=%.3f  max=%.3f  mean=%.3f  median=%.3f",
                 ur_arr.min(), ur_arr.max(), ur_arr.mean(), np.median(ur_arr))
        log.info("  PnL vs unit_return: same=%d, different=%d",
                 (np.isclose(pnl_arr, ur_arr, atol=1e-6)).sum(),
                 (~np.isclose(pnl_arr, ur_arr, atol=1e-6)).sum())

    # ── CLV analysis ───────────────────────────────────────────────────
    if "clv_pct" in data.metadata.columns:
        clv_arr = data.metadata["clv_pct"].to_numpy().astype(np.float64)
        finite_clv = clv_arr[np.isfinite(clv_arr)]
        log.info("")
        log.info("═══ CLV ANALYSIS ═══")
        log.info("  Finite CLV values: %d / %d", len(finite_clv), len(clv_arr))
        if len(finite_clv) > 0:
            log.info("  min=%.3f  max=%.3f  mean=%.3f  median=%.3f",
                     finite_clv.min(), finite_clv.max(), finite_clv.mean(), np.median(finite_clv))

    # ── Feature distribution ───────────────────────────────────────────
    log.info("")
    log.info("═══ FEATURE DISTRIBUTION ═══")
    from app.feature_names import FEATURE_NAMES
    for i, name in enumerate(FEATURE_NAMES):
        col = data.features[:, i]
        finite = col[np.isfinite(col)]
        if len(finite) > 0:
            log.info("  %-25s min=%8.3f max=%8.3f mean=%8.3f std=%8.3f nan=%d",
                     name, finite.min(), finite.max(), finite.mean(), finite.std(),
                     len(col) - len(finite))

    # ── Train model ────────────────────────────────────────────────────
    log.info("")
    log.info("═══ TRAINING MODEL ═══")
    from app.trainer import train

    result = train(data)
    metrics = result.metrics

    log.info("")
    log.info("═══ TRAINING METRICS ═══")
    log.info("  AUC-ROC:          %.4f", metrics.auc_roc)
    log.info("  Accuracy:         %.4f", metrics.accuracy)
    log.info("  Log Loss:         %.6f", metrics.log_loss_val)
    log.info("  Calibration Err:  %.6f", metrics.calibration_error)
    log.info("  OOS ROI Mean:     %.4f%%", metrics.oos_roi_mean)
    log.info("  OOS CLV Mean:     %.4f%%", metrics.oos_clv_mean)
    log.info("  DSR:              %.4f", metrics.dsr)
    log.info("  PBO:              %.4f", metrics.pbo)

    # ── SHAP feature importance ────────────────────────────────────────
    if metrics.feature_importance:
        log.info("")
        log.info("═══ TOP FEATURES BY SHAP ═══")
        sorted_feats = sorted(metrics.feature_importance.items(), key=lambda x: -x[1])
        for name, importance in sorted_feats[:15]:
            log.info("  %-30s %.6f", name, importance)

    # ── DEEP BUCKET ANALYSIS ──────────────────────────────────────────
    report = metrics.score_bucket_report
    if report:
        log.info("")
        log.info("═══ SCORE BUCKET ANALYSIS (THE KEY ISSUE) ═══")
        log.info("  roi_monotonicity:      %.4f (gate requires >= 0.6)", report.roi_monotonicity)
        log.info("  clv_monotonicity:      %.4f", report.clv_monotonicity)
        log.info("  win_rate_monotonicity:  %.4f", report.win_rate_monotonicity)
        log.info("  is_directionally_mono:  %s", report.is_directionally_monotonic)
        log.info("")
        log.info("  %-10s %6s %6s %6s %8s %8s %8s %8s",
                 "Bucket", "Count", "Pos", "Neg", "WinRate", "ROI%", "CLV%", "MeanScr")
        log.info("  " + "-" * 72)
        for b in report.buckets:
            clv_str = f"{b.mean_clv_pct:8.2f}" if math.isfinite(b.mean_clv_pct) else "     N/A"
            log.info("  %-10s %6d %6d %6d %7.1f%% %7.1f%% %s %8.4f",
                     b.label, b.count, b.n_positive, b.n_negative,
                     b.win_rate * 100, b.roi_pct, clv_str, b.mean_score)

        # ── Identify WHICH adjacent pairs break monotonicity ───────────
        log.info("")
        log.info("═══ MONOTONICITY PAIR ANALYSIS ═══")
        non_empty = [(b.label, b.roi_pct, b.count, b.win_rate, b.mean_pnl)
                     for b in report.buckets if b.count > 0]

        pairs_ok = 0
        pairs_bad = 0
        for i in range(len(non_empty) - 1):
            lbl_a, roi_a, cnt_a, wr_a, pnl_a = non_empty[i]
            lbl_b, roi_b, cnt_b, wr_b, pnl_b = non_empty[i + 1]
            direction = "✅" if roi_b >= roi_a else "❌"
            if roi_b >= roi_a:
                pairs_ok += 1
            else:
                pairs_bad += 1
            log.info("  %s %s (ROI=%.1f%%, n=%d) → %s (ROI=%.1f%%, n=%d)  Δ=%+.1f%%",
                     direction, lbl_a, roi_a, cnt_a, lbl_b, roi_b, cnt_b, roi_b - roi_a)

        log.info("  Result: %d/%d pairs monotonic = %.2f",
                 pairs_ok, pairs_ok + pairs_bad,
                 pairs_ok / (pairs_ok + pairs_bad) if (pairs_ok + pairs_bad) > 0 else 1.0)

    # ── Score distribution analysis ────────────────────────────────────
    valid_mask = ~np.isnan(result.oos_predictions)
    oos_scores = result.oos_predictions[valid_mask]
    oos_labels = result.oos_labels[valid_mask]
    oos_pnl = pnl_arr[valid_mask]

    log.info("")
    log.info("═══ OOS SCORE DISTRIBUTION ═══")
    log.info("  min=%.4f  max=%.4f  mean=%.4f  std=%.4f",
             oos_scores.min(), oos_scores.max(), oos_scores.mean(), oos_scores.std())

    # Score percentiles
    for pct in [1, 5, 10, 25, 50, 75, 90, 95, 99]:
        log.info("  P%02d: %.4f", pct, np.percentile(oos_scores, pct))

    # ── Correlation: Score vs PnL ──────────────────────────────────────
    from scipy import stats as sp_stats

    corr, p_val = sp_stats.pearsonr(oos_scores, oos_pnl)
    spearman_corr, sp_p_val = sp_stats.spearmanr(oos_scores, oos_pnl)
    log.info("")
    log.info("═══ SCORE-PNL CORRELATION ═══")
    log.info("  Pearson:  r=%.4f  p=%.4f", corr, p_val)
    log.info("  Spearman: r=%.4f  p=%.4f", spearman_corr, sp_p_val)

    # ── Score vs Win Rate across deciles ──────────────────────────────
    log.info("")
    log.info("═══ SCORE DECILE ANALYSIS ═══")
    log.info("  %-12s %6s %8s %8s %8s", "Decile", "Count", "WinRate", "ROI%", "MeanScr")
    log.info("  " + "-" * 52)

    decile_edges = np.percentile(oos_scores, np.arange(0, 101, 10))
    for i in range(10):
        lo = decile_edges[i]
        hi = decile_edges[i + 1] if i < 9 else oos_scores.max() + 0.01
        mask = (oos_scores >= lo) & (oos_scores < hi)
        cnt = mask.sum()
        if cnt == 0:
            continue
        wr = oos_labels[mask].mean()
        roi = oos_pnl[mask].sum() / cnt * 100
        ms = oos_scores[mask].mean()
        log.info("  D%-10d %6d %7.1f%% %7.1f%% %8.4f",
                 i + 1, cnt, wr * 100, roi, ms)

    # ── Check if the problem is small noisy buckets ────────────────────
    log.info("")
    log.info("═══ DIAGNOSIS SUMMARY ═══")

    if report:
        small_buckets = [b for b in report.buckets if 0 < b.count < 30]
        if small_buckets:
            log.info("  ⚠️  SMALL BUCKETS: %d buckets have < 30 samples:", len(small_buckets))
            for b in small_buckets:
                log.info("    %s: %d samples (ROI=%.1f%%)", b.label, b.count, b.roi_pct)
            log.info("  → Small buckets create noise that breaks monotonicity.")
            log.info("  → Consider: merging small buckets, or using monotonic constraints in LightGBM.")

        # Check if the issue is the lowest-score bucket having high ROI
        if len(report.buckets) >= 2:
            first_nonempty = next((b for b in report.buckets if b.count > 0), None)
            last_nonempty = next((b for b in reversed(report.buckets) if b.count > 0), None)
            if first_nonempty and last_nonempty:
                if first_nonempty.roi_pct > last_nonempty.roi_pct:
                    log.info("  ⚠️  INVERTED: Lowest bucket (ROI=%.1f%%) > Highest bucket (ROI=%.1f%%)",
                             first_nonempty.roi_pct, last_nonempty.roi_pct)
                    log.info("  → The model's score is ANTI-correlated with profitability!")
                    log.info("  → This suggests the model has learned noise or the wrong signal.")

    # ── Deployment gate simulation ─────────────────────────────────────
    log.info("")
    log.info("═══ DEPLOYMENT GATE CHECK ═══")
    from app.deployment_gate import evaluate_deployment_gate

    gate = evaluate_deployment_gate(metrics)
    log.info("  Approved: %s", gate.approved)
    log.info("  Permission: %s", gate.permission_level)
    if gate.rejection_reasons:
        for r in gate.rejection_reasons:
            log.info("  ❌ %s", r)
    if gate.warnings:
        for w in gate.warnings:
            log.info("  ⚠️  %s", w)

    log.info("")
    log.info("=" * 72)
    log.info("OBSERVER COMPLETE")
    log.info("=" * 72)


if __name__ == "__main__":
    main()
