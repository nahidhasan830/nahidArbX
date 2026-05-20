"""Model Deployment Gate — prevents bad or overfit models from reaching runtime.

Phase 7 of the ML optimizer plan. Enforces strict quality requirements
before a model can be deployed to production scoring. Assigns a runtime
permission level based on the model's quality metrics and the amount of
available training data.

Deployment requirements for first observe model:
  - At least MIN_VALID_EXAMPLES valid settled examples after feature normalization
  - Feature version matches runtime
  - No feature length drift
  - AUC above AUC_BASELINE
  - Bucket ROI/CLV is directionally monotonic
  - No severe calibration failure

Phase 5 changes:
  - PBO removed from hard gates (single-trial PBO is always 0.0 and
    meaningless — demoted to warning-only).

Runtime permission levels (escalation order):
  - observe: score and log only — no effect on placement
  - gate_only: can skip bets whose model EV is not positive
  - stake_reduce: can reduce stake on weak bets
  - stake_increase: disabled until enough real placed-settled evidence exists
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field

from .trainer import TrainingMetrics

log = logging.getLogger(__name__)


# ── Gate thresholds ────────────────────────────────────────────────────────

# Minimum valid settled examples after feature normalization
MIN_VALID_EXAMPLES = 200

# AUC must beat random baseline
AUC_BASELINE = 0.55

# Maximum acceptable calibration error (ECE)
MAX_CALIBRATION_ERROR = 0.15

# Maximum acceptable log loss (anything above this is worse than random-ish)
MAX_LOG_LOSS = 0.75

# Minimum ROI monotonicity across score buckets.
# Lowered to 0.5 in sync with the calibration clip [0.05, 0.95] (post-2026-05
# AH fix). Clipped calibration produces more-moderate edge estimates, which
# reduces per-bucket ROI variance and makes the 0.6 bar unreachable without
# extreme 0/1 probabilities.
MIN_ROI_MONOTONICITY = 0.5

# Minimum CLV monotonicity across score buckets (softer requirement)
MIN_CLV_MONOTONICITY = 0.3

# Minimum out-of-sample live-policy evidence. The live policy gates on
# positive model EV at the offered odds, so deployment must prove that the
# policy cohort itself has enough samples and non-negative ROI.
MIN_POLICY_SAMPLES = 100
MIN_POLICY_ROI = 0.0

# Active ML permissions must add value over the non-ML baseline rule, not just
# be positive in isolation. Observe-level deployment still logs, but gate_only
# or stake_reduce need enough baseline comparison samples and non-negative
# incremental ROI.
MIN_SIMPLE_COMPARISON_SAMPLES = 100
MIN_MODEL_VS_SIMPLE_ROI_DELTA = 0.0
MIN_MODEL_VS_SIMPLE_LCB_DELTA = 0.0

# DSR threshold. A deployed model must show statistically credible
# out-of-sample policy returns, even if it would only run at observe level.
# Active permissions remain stricter below.
MIN_DSR = 0.6

# PBO threshold — Phase 5: demoted to warning-only because single-trial
# PBO is always 0.0 (meaningless until multiple real trials exist).
# Kept as a constant for future use when multi-trial PBO is implemented.
MAX_PBO = 0.6

# ── Permission level escalation thresholds ─────────────────────────────────

# gate_only requires stronger evidence than observe
GATE_ONLY_MIN_AUC = 0.60
GATE_ONLY_MIN_EXAMPLES = 1500
GATE_ONLY_MIN_DSR = 0.7
GATE_ONLY_MIN_POLICY_SAMPLES = 250

# stake_reduce requires even stronger evidence
STAKE_REDUCE_MIN_AUC = 0.65
STAKE_REDUCE_MIN_EXAMPLES = 2000
STAKE_REDUCE_MIN_DSR = 0.8
STAKE_REDUCE_MIN_ROI_MONOTONICITY = 0.8
STAKE_REDUCE_MIN_POLICY_ROI = 1.0

# stake_increase is disabled for now — requires real placed-settled evidence
# that doesn't exist yet. This is intentionally impossible to reach.
STAKE_INCREASE_MIN_PLACED_SETTLED = 500  # placed bets that settled


# ── Permission levels ──────────────────────────────────────────────────────

PERMISSION_LEVELS = ("observe", "gate_only", "stake_reduce", "stake_increase")


@dataclass(frozen=True)
class DeploymentGateResult:
    """Result of the deployment gate evaluation."""

    approved: bool
    permission_level: str  # One of PERMISSION_LEVELS
    rejection_reasons: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def evaluate_deployment_gate(
    metrics: TrainingMetrics,
    *,
    n_placed_settled: int = 0,
    feature_version_matches: bool = True,
    feature_count_matches: bool = True,
) -> DeploymentGateResult:
    """Evaluate whether a trained model should be deployed and at what permission level.

    Args:
        metrics: Training metrics from the CPCV training run.
        n_placed_settled: Number of placed bets that have settled (for stake_increase).
        feature_version_matches: Whether the model's feature version matches runtime.
        feature_count_matches: Whether the model's feature count matches runtime.

    Returns:
        DeploymentGateResult with approval status, permission level, and reasons.
    """
    reasons: list[str] = []
    warnings: list[str] = []

    # ── Hard gates (any failure → rejection) ──────────────────────────

    # Feature contract checks
    if not feature_version_matches:
        reasons.append(
            "Feature version mismatch: model feature version does not match runtime"
        )

    if not feature_count_matches:
        reasons.append(
            "Feature count mismatch: model feature count does not match runtime"
        )

    # Minimum sample size
    if metrics.n_samples < MIN_VALID_EXAMPLES:
        reasons.append(
            f"Insufficient training data: {metrics.n_samples} samples, "
            f"need at least {MIN_VALID_EXAMPLES}"
        )

    # AUC above random baseline
    if metrics.auc_roc < AUC_BASELINE:
        reasons.append(
            f"AUC-ROC too low: {metrics.auc_roc:.4f}, "
            f"need at least {AUC_BASELINE}"
        )

    # Calibration error check
    if metrics.calibration_error > MAX_CALIBRATION_ERROR:
        reasons.append(
            f"Severe calibration failure: ECE={metrics.calibration_error:.6f}, "
            f"max allowed {MAX_CALIBRATION_ERROR}"
        )

    # Log loss check
    if metrics.log_loss_val > MAX_LOG_LOSS:
        reasons.append(
            f"Log loss too high: {metrics.log_loss_val:.6f}, "
            f"max allowed {MAX_LOG_LOSS}"
        )

    # Score bucket monotonicity
    if metrics.score_bucket_report is not None:
        report = metrics.score_bucket_report
        has_clv_monotonicity = (
            sum(1 for bucket in report.buckets if math.isfinite(bucket.mean_clv_pct))
            >= 2
        )
        # Profit monotonicity: active edge ranking must improve financial
        # outcomes. Use ROI plus CLV when CLV exists; otherwise fall back to
        # ROI. Win-rate monotonicity is diagnostic only because odds mix can
        # make profitable higher-edge cohorts hit less often.
        profit_mono = (
            (report.roi_monotonicity + report.clv_monotonicity) / 2.0
            if has_clv_monotonicity
            else report.roi_monotonicity
        )
        if profit_mono < MIN_ROI_MONOTONICITY:
            reasons.append(
                f"Score bucket profit monotonicity too weak: "
                f"{profit_mono:.4f}, need at least {MIN_ROI_MONOTONICITY}"
            )
        if has_clv_monotonicity and report.clv_monotonicity <= MIN_CLV_MONOTONICITY:
            warnings.append(
                f"Score bucket CLV monotonicity is weak: "
                f"{report.clv_monotonicity:.4f}, ideally above {MIN_CLV_MONOTONICITY}"
            )
        if report.win_rate_monotonicity < MIN_ROI_MONOTONICITY:
            warnings.append(
                f"Score bucket win-rate monotonicity is weak: "
                f"{report.win_rate_monotonicity:.4f}; odds-adjusted ROI/CLV "
                "remain the deployment objective"
            )
    else:
        reasons.append("No score bucket report available — cannot verify monotonicity")

    if metrics.policy_sample_size < MIN_POLICY_SAMPLES:
        reasons.append(
            f"Insufficient ML-gated policy sample: {metrics.policy_sample_size} bets, "
            f"need at least {MIN_POLICY_SAMPLES}"
        )

    if metrics.policy_roi_mean < MIN_POLICY_ROI:
        reasons.append(
            f"ML-gated policy ROI is negative: {metrics.policy_roi_mean:.4f}%, "
            f"need at least {MIN_POLICY_ROI:.4f}%"
        )

    has_simple_comparison = metrics.simple_policy_sample_size >= MIN_SIMPLE_COMPARISON_SAMPLES
    if has_simple_comparison and metrics.model_vs_simple_roi_delta < MIN_MODEL_VS_SIMPLE_ROI_DELTA:
        warnings.append(
            f"ML-gated policy underperforms simple EV rule by "
            f"{abs(metrics.model_vs_simple_roi_delta):.4f} ROI points; "
            "active permissions will stay disabled until incremental edge is non-negative"
        )
    if has_simple_comparison and metrics.policy_lower_confidence_roi_pct < MIN_MODEL_VS_SIMPLE_LCB_DELTA:
        warnings.append(
            f"ML-gated policy lower confidence edge over simple EV is "
            f"{metrics.policy_lower_confidence_roi_pct:.4f} ROI points; "
            "active permissions require the conservative bound to be non-negative"
        )

    # DSR check
    if math.isnan(metrics.dsr) or metrics.dsr < MIN_DSR:
        reasons.append(
            f"Deflated Sharpe Ratio too low or invalid: {metrics.dsr:.4f}, "
            f"need at least {MIN_DSR}"
        )

    # PBO check — Phase 5: demoted to warning-only. Single-trial PBO is
    # always 0.0 by construction (pbo_score requires n_trials >= 2). Until
    # multi-trial PBO is implemented, this check would either always pass
    # (PBO=0.0) or reject meaningful models if PBO computation changes.
    if metrics.pbo > MAX_PBO:
        warnings.append(
            f"Probability of Backtest Overfitting is high: {metrics.pbo:.4f}, "
            f"threshold {MAX_PBO} (warning only — not a hard gate)"
        )

    # ── If any hard gate failed, reject ──────────────────────────────

    if reasons:
        log.warning(
            "Model REJECTED by deployment gate (%d reasons): %s",
            len(reasons), "; ".join(reasons),
        )
        return DeploymentGateResult(
            approved=False,
            permission_level="observe",
            rejection_reasons=reasons,
            warnings=warnings,
        )

    # ── Determine permission level (escalation order) ─────────────────

    # Start at observe (always safe)
    level = "observe"
    beats_simple_rule = (
        metrics.simple_policy_sample_size >= MIN_SIMPLE_COMPARISON_SAMPLES
        and metrics.model_vs_simple_roi_delta >= MIN_MODEL_VS_SIMPLE_ROI_DELTA
        and metrics.policy_lower_confidence_roi_pct >= MIN_MODEL_VS_SIMPLE_LCB_DELTA
    )

    # Can we escalate to gate_only?
    if (
        metrics.auc_roc >= GATE_ONLY_MIN_AUC
        and metrics.n_samples >= GATE_ONLY_MIN_EXAMPLES
        and metrics.dsr >= GATE_ONLY_MIN_DSR
        and metrics.policy_sample_size >= GATE_ONLY_MIN_POLICY_SAMPLES
        and beats_simple_rule
        and metrics.score_bucket_report is not None
        and metrics.score_bucket_report.is_directionally_monotonic
    ):
        level = "gate_only"

        # Can we further escalate to stake_reduce?
        if (
            metrics.auc_roc >= STAKE_REDUCE_MIN_AUC
            and metrics.n_samples >= STAKE_REDUCE_MIN_EXAMPLES
            and metrics.dsr >= STAKE_REDUCE_MIN_DSR
            and metrics.score_bucket_report.roi_monotonicity >= STAKE_REDUCE_MIN_ROI_MONOTONICITY
            and metrics.policy_roi_mean >= STAKE_REDUCE_MIN_POLICY_ROI
        ):
            level = "stake_reduce"

            # stake_increase requires real placed-settled evidence
            if n_placed_settled >= STAKE_INCREASE_MIN_PLACED_SETTLED:
                level = "stake_increase"
            else:
                warnings.append(
                    f"stake_increase disabled: only {n_placed_settled} placed-settled bets, "
                    f"need {STAKE_INCREASE_MIN_PLACED_SETTLED}"
                )

    log.info(
        "Model APPROVED by deployment gate: permission_level=%s, AUC=%.4f, "
        "DSR=%.4f, PBO=%.4f, n=%d, policyROI=%.2f%%, policyN=%d",
        level, metrics.auc_roc, metrics.dsr, metrics.pbo, metrics.n_samples,
        metrics.policy_roi_mean, metrics.policy_sample_size,
    )

    return DeploymentGateResult(
        approved=True,
        permission_level=level,
        rejection_reasons=[],
        warnings=warnings,
    )
