"""Tests for the Phase 7 deployment gate.

Verifies that the deployment gate correctly evaluates training metrics
and assigns appropriate permission levels or rejection reasons.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.deployment_gate import (
    AUC_BASELINE,
    GATE_ONLY_MIN_AUC,
    GATE_ONLY_MIN_DSR,
    GATE_ONLY_MIN_EXAMPLES,
    MAX_CALIBRATION_ERROR,
    MAX_LOG_LOSS,
    MAX_PBO,
    MIN_CLV_MONOTONICITY,
    MIN_DSR,
    MIN_ROI_MONOTONICITY,
    MIN_VALID_EXAMPLES,
    STAKE_INCREASE_MIN_PLACED_SETTLED,
    STAKE_REDUCE_MIN_AUC,
    STAKE_REDUCE_MIN_DSR,
    STAKE_REDUCE_MIN_EXAMPLES,
    STAKE_REDUCE_MIN_ROI_MONOTONICITY,
    DeploymentGateResult,
    evaluate_deployment_gate,
)
from app.scoring import ScoreBucket, ScoreBucketReport
from app.trainer import TrainingMetrics


def _make_metrics(
    *,
    auc_roc: float = 0.72,
    accuracy: float = 0.65,
    log_loss_val: float = 0.55,
    calibration_error: float = 0.04,
    oos_roi_mean: float = 5.0,
    oos_clv_mean: float = 2.0,
    policy_roi_mean: float = 4.0,
    policy_sample_size: int = 400,
    policy_coverage: float = 0.25,
    baseline_roi_mean: float = 2.0,
    simple_policy_roi_mean: float = 2.0,
    simple_policy_sample_size: int = 250,
    simple_policy_coverage: float = 0.2,
    model_vs_simple_roi_delta: float | None = None,
    dsr: float = 0.85,
    pbo: float = 0.15,
    n_samples: int = 1500,
    n_positive: int = 600,
    n_negative: int = 900,
    n_folds: int = 45,
    roi_monotonicity: float = 0.8,
    clv_monotonicity: float = 0.6,
    win_rate_monotonicity: float = 0.7,
    is_directionally_monotonic: bool = True,
) -> TrainingMetrics:
    """Build a TrainingMetrics with sensible defaults that pass the gate."""
    buckets = [
        ScoreBucket(
            label=f"bucket-{i}", low=i * 0.2, high=(i + 1) * 0.2,
            count=100, n_positive=50, n_negative=50,
            win_rate=0.5, mean_pnl=1.0, roi_pct=5.0,
            mean_clv_pct=2.0, mean_score=i * 0.2 + 0.1,
        )
        for i in range(6)
    ]
    report = ScoreBucketReport(
        buckets=buckets,
        roi_monotonicity=roi_monotonicity,
        clv_monotonicity=clv_monotonicity,
        win_rate_monotonicity=win_rate_monotonicity,
        is_directionally_monotonic=is_directionally_monotonic,
    )
    return TrainingMetrics(
        auc_roc=auc_roc,
        accuracy=accuracy,
        log_loss_val=log_loss_val,
        calibration_error=calibration_error,
        oos_roi_mean=oos_roi_mean,
        oos_clv_mean=oos_clv_mean,
        policy_roi_mean=policy_roi_mean,
        policy_sample_size=policy_sample_size,
        policy_coverage=policy_coverage,
        policy_edge_threshold_pct=0.0,
        baseline_roi_mean=baseline_roi_mean,
        simple_policy_roi_mean=simple_policy_roi_mean,
        simple_policy_sample_size=simple_policy_sample_size,
        simple_policy_coverage=simple_policy_coverage,
        model_vs_simple_roi_delta=(
            policy_roi_mean - simple_policy_roi_mean
            if model_vs_simple_roi_delta is None
            else model_vs_simple_roi_delta
        ),
        dsr=dsr,
        pbo=pbo,
        n_samples=n_samples,
        n_positive=n_positive,
        n_negative=n_negative,
        n_folds=n_folds,
        score_bucket_report=report,
    )


class TestDeploymentGateApproval:
    """Test that good models get approved."""

    def test_good_model_approved(self):
        metrics = _make_metrics()
        result = evaluate_deployment_gate(metrics)
        assert result.approved
        assert len(result.rejection_reasons) == 0

    def test_approved_model_gets_permission_level(self):
        metrics = _make_metrics()
        result = evaluate_deployment_gate(metrics)
        assert result.permission_level in ("observe", "gate_only", "stake_reduce")


class TestDeploymentGateRejection:
    """Test that bad models get rejected with proper reasons."""

    def test_insufficient_samples(self):
        metrics = _make_metrics(n_samples=150)
        result = evaluate_deployment_gate(metrics)
        assert not result.approved
        assert any("Insufficient training data" in r for r in result.rejection_reasons)

    def test_low_auc(self):
        metrics = _make_metrics(auc_roc=0.50)
        result = evaluate_deployment_gate(metrics)
        assert not result.approved
        assert any("AUC-ROC too low" in r for r in result.rejection_reasons)

    def test_severe_calibration_error(self):
        metrics = _make_metrics(calibration_error=0.25)
        result = evaluate_deployment_gate(metrics)
        assert not result.approved
        assert any("calibration failure" in r for r in result.rejection_reasons)

    def test_high_log_loss(self):
        metrics = _make_metrics(log_loss_val=0.90)
        result = evaluate_deployment_gate(metrics)
        assert not result.approved
        assert any("Log loss too high" in r for r in result.rejection_reasons)

    def test_low_roi_monotonicity(self):
        # Profit metric: (roi + clv) / 2 must be >= 0.6 when CLV is available.
        # With roi=0.3 and clv=0.3, profit monotonicity = 0.3 -> rejected.
        metrics = _make_metrics(
            roi_monotonicity=0.3,
            clv_monotonicity=0.3,
            win_rate_monotonicity=0.9,
            is_directionally_monotonic=False,
        )
        result = evaluate_deployment_gate(metrics)
        assert not result.approved
        assert any("profit monotonicity" in r for r in result.rejection_reasons)

    def test_low_dsr(self):
        metrics = _make_metrics(dsr=0.4)
        result = evaluate_deployment_gate(metrics)
        assert not result.approved
        assert any("Deflated Sharpe" in r for r in result.rejection_reasons)

    def test_high_pbo(self):
        """Phase 5: PBO is now a warning, not a hard rejection gate."""
        metrics = _make_metrics(pbo=0.8)
        result = evaluate_deployment_gate(metrics)
        assert result.approved, (
            f"PBO should not cause rejection (Phase 5). Reasons: {result.rejection_reasons}"
        )
        assert any("Overfitting" in w or "PBO" in w for w in result.warnings)

    def test_feature_version_mismatch(self):
        metrics = _make_metrics()
        result = evaluate_deployment_gate(
            metrics, feature_version_matches=False
        )
        assert not result.approved
        assert any("Feature version mismatch" in r for r in result.rejection_reasons)

    def test_feature_count_mismatch(self):
        metrics = _make_metrics()
        result = evaluate_deployment_gate(
            metrics, feature_count_matches=False
        )
        assert not result.approved
        assert any("Feature count mismatch" in r for r in result.rejection_reasons)

    def test_no_score_bucket_report(self):
        metrics = _make_metrics()
        # Override to remove the report
        metrics_no_report = TrainingMetrics(
            auc_roc=metrics.auc_roc,
            accuracy=metrics.accuracy,
            log_loss_val=metrics.log_loss_val,
            calibration_error=metrics.calibration_error,
            oos_roi_mean=metrics.oos_roi_mean,
            oos_clv_mean=metrics.oos_clv_mean,
            policy_roi_mean=metrics.policy_roi_mean,
            policy_sample_size=metrics.policy_sample_size,
            policy_coverage=metrics.policy_coverage,
            policy_edge_threshold_pct=metrics.policy_edge_threshold_pct,
            dsr=metrics.dsr,
            pbo=metrics.pbo,
            n_samples=metrics.n_samples,
            n_positive=metrics.n_positive,
            n_negative=metrics.n_negative,
            n_folds=metrics.n_folds,
            score_bucket_report=None,
        )
        result = evaluate_deployment_gate(metrics_no_report)
        assert not result.approved
        assert any("No score bucket report" in r for r in result.rejection_reasons)

    def test_multiple_rejection_reasons(self):
        """A model failing multiple gates should list all reasons."""
        metrics = _make_metrics(
            auc_roc=0.50,
            n_samples=150,
            calibration_error=0.25,
        )
        result = evaluate_deployment_gate(metrics)
        assert not result.approved
        assert len(result.rejection_reasons) >= 2


class TestPermissionLevels:
    """Test permission level assignment based on metric quality."""

    def test_observe_level_for_baseline_model(self):
        """Model that barely passes should get observe level."""
        metrics = _make_metrics(
            auc_roc=0.56,
            n_samples=1100,
            dsr=0.65,
            roi_monotonicity=0.6,  # Barely passes the hard gate
            is_directionally_monotonic=True,
        )
        result = evaluate_deployment_gate(metrics)
        assert result.approved
        assert result.permission_level == "observe"

    def test_gate_only_level(self):
        """Model with solid metrics should get gate_only level."""
        metrics = _make_metrics(
            auc_roc=GATE_ONLY_MIN_AUC + 0.01,
            n_samples=GATE_ONLY_MIN_EXAMPLES + 100,
            dsr=GATE_ONLY_MIN_DSR + 0.01,
            roi_monotonicity=0.8,
            is_directionally_monotonic=True,
        )
        result = evaluate_deployment_gate(metrics)
        assert result.approved
        assert result.permission_level in ("gate_only", "stake_reduce")

    def test_gate_only_requires_simple_rule_outperformance(self):
        """Active permissions stay disabled when ML trails the simple EV rule."""
        metrics = _make_metrics(
            auc_roc=GATE_ONLY_MIN_AUC + 0.03,
            n_samples=GATE_ONLY_MIN_EXAMPLES + 100,
            dsr=GATE_ONLY_MIN_DSR + 0.03,
            policy_roi_mean=1.0,
            simple_policy_roi_mean=3.0,
            simple_policy_sample_size=300,
            model_vs_simple_roi_delta=-2.0,
        )
        result = evaluate_deployment_gate(metrics)
        assert result.approved
        assert result.permission_level == "observe"
        assert any("underperforms simple EV rule" in w for w in result.warnings)

    def test_stake_reduce_level(self):
        """Model with excellent metrics should get stake_reduce level."""
        metrics = _make_metrics(
            auc_roc=STAKE_REDUCE_MIN_AUC + 0.01,
            n_samples=STAKE_REDUCE_MIN_EXAMPLES + 100,
            dsr=STAKE_REDUCE_MIN_DSR + 0.01,
            roi_monotonicity=STAKE_REDUCE_MIN_ROI_MONOTONICITY + 0.01,
            is_directionally_monotonic=True,
        )
        result = evaluate_deployment_gate(metrics)
        assert result.approved
        assert result.permission_level == "stake_reduce"

    def test_stake_increase_requires_placed_settled(self):
        """stake_increase requires real placed-settled evidence."""
        metrics = _make_metrics(
            auc_roc=0.75,
            n_samples=3000,
            dsr=0.9,
            roi_monotonicity=0.9,
            is_directionally_monotonic=True,
        )
        # Without placed-settled bets, can't reach stake_increase
        result = evaluate_deployment_gate(metrics, n_placed_settled=0)
        assert result.approved
        assert result.permission_level == "stake_reduce"
        assert any("stake_increase disabled" in w for w in result.warnings)

    def test_stake_increase_with_placed_settled(self):
        """stake_increase should be granted with enough placed-settled data."""
        metrics = _make_metrics(
            auc_roc=0.75,
            n_samples=3000,
            dsr=0.9,
            roi_monotonicity=0.9,
            is_directionally_monotonic=True,
        )
        result = evaluate_deployment_gate(
            metrics,
            n_placed_settled=STAKE_INCREASE_MIN_PLACED_SETTLED + 1,
        )
        assert result.approved
        assert result.permission_level == "stake_increase"


class TestDeploymentGateWarnings:
    """Test that soft warnings are generated for non-critical issues."""

    def test_weak_clv_monotonicity_warning(self):
        """Low CLV monotonicity should produce a warning, not rejection."""
        metrics = _make_metrics(roi_monotonicity=1.0, clv_monotonicity=0.3)
        result = evaluate_deployment_gate(metrics)
        assert result.approved  # CLV monotonicity is a soft check
        assert any("CLV monotonicity" in w for w in result.warnings)

    def test_weak_win_rate_monotonicity_is_warning_only(self):
        """Profitable high-edge odds buckets may have lower raw hit rate."""
        metrics = _make_metrics(
            roi_monotonicity=0.8,
            clv_monotonicity=1.0,
            win_rate_monotonicity=0.4,
            is_directionally_monotonic=True,
        )
        result = evaluate_deployment_gate(metrics)
        assert result.approved
        assert any("win-rate monotonicity" in w for w in result.warnings)
