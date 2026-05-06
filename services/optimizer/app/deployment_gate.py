"""Model Deployment Gate — prevents bad or overfit models from reaching runtime.

Phase 7 of the ML optimizer plan. Enforces strict quality requirements
before a model can be deployed to production scoring. Assigns a runtime
permission level based on the model's quality metrics and the amount of
available training data.

Deployment requirements for first shadow model:
  - At least MIN_VALID_EXAMPLES valid settled examples after feature normalization
  - Feature version matches runtime
  - No feature length drift
  - AUC above AUC_BASELINE
  - Bucket ROI/CLV is directionally monotonic
  - No severe calibration failure

Runtime permission levels (escalation order):
  - shadow: score and log only — no effect on placement
  - gate_only: can skip low-score bets
  - stake_reduce: can reduce stake on weak bets
  - stake_increase: disabled until enough real placed-settled evidence exists
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from .trainer import TrainingMetrics

log = logging.getLogger(__name__)


# ── Gate thresholds ────────────────────────────────────────────────────────

# Minimum valid settled examples after feature normalization
MIN_VALID_EXAMPLES = 1000

# AUC must beat random baseline
AUC_BASELINE = 0.55

# Maximum acceptable calibration error (ECE)
MAX_CALIBRATION_ERROR = 0.15

# Maximum acceptable log loss (anything above this is worse than random-ish)
MAX_LOG_LOSS = 0.75

# Minimum ROI monotonicity across score buckets
MIN_ROI_MONOTONICITY = 0.6

# Minimum CLV monotonicity across score buckets (softer requirement)
MIN_CLV_MONOTONICITY = 0.4

# DSR/PBO thresholds (same as config defaults, but enforced here too)
MIN_DSR = 0.6
MAX_PBO = 0.6

# ── Permission level escalation thresholds ─────────────────────────────────

# gate_only requires stronger evidence than shadow
GATE_ONLY_MIN_AUC = 0.60
GATE_ONLY_MIN_EXAMPLES = 1500
GATE_ONLY_MIN_DSR = 0.7

# stake_reduce requires even stronger evidence
STAKE_REDUCE_MIN_AUC = 0.65
STAKE_REDUCE_MIN_EXAMPLES = 2000
STAKE_REDUCE_MIN_DSR = 0.8
STAKE_REDUCE_MIN_ROI_MONOTONICITY = 0.8

# stake_increase is disabled for now — requires real placed-settled evidence
# that doesn't exist yet. This is intentionally impossible to reach.
STAKE_INCREASE_MIN_PLACED_SETTLED = 500  # placed bets that settled


# ── Permission levels ──────────────────────────────────────────────────────

PERMISSION_LEVELS = ("shadow", "gate_only", "stake_reduce", "stake_increase")


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
        if report.roi_monotonicity < MIN_ROI_MONOTONICITY:
            reasons.append(
                f"Score bucket ROI not directionally monotonic: "
                f"{report.roi_monotonicity:.4f}, need at least {MIN_ROI_MONOTONICITY}"
            )
        if report.clv_monotonicity < MIN_CLV_MONOTONICITY:
            warnings.append(
                f"Score bucket CLV monotonicity is weak: "
                f"{report.clv_monotonicity:.4f}, ideally above {MIN_CLV_MONOTONICITY}"
            )
    else:
        reasons.append("No score bucket report available — cannot verify monotonicity")

    # DSR check
    if metrics.dsr < MIN_DSR:
        reasons.append(
            f"Deflated Sharpe Ratio too low: {metrics.dsr:.4f}, "
            f"need at least {MIN_DSR}"
        )

    # PBO check
    if metrics.pbo > MAX_PBO:
        reasons.append(
            f"Probability of Backtest Overfitting too high: {metrics.pbo:.4f}, "
            f"max allowed {MAX_PBO}"
        )

    # ── If any hard gate failed, reject ──────────────────────────────

    if reasons:
        log.warning(
            "Model REJECTED by deployment gate (%d reasons): %s",
            len(reasons), "; ".join(reasons),
        )
        return DeploymentGateResult(
            approved=False,
            permission_level="shadow",
            rejection_reasons=reasons,
            warnings=warnings,
        )

    # ── Determine permission level (escalation order) ─────────────────

    # Start at shadow (always safe)
    level = "shadow"

    # Can we escalate to gate_only?
    if (
        metrics.auc_roc >= GATE_ONLY_MIN_AUC
        and metrics.n_samples >= GATE_ONLY_MIN_EXAMPLES
        and metrics.dsr >= GATE_ONLY_MIN_DSR
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
        "DSR=%.4f, PBO=%.4f, n=%d",
        level, metrics.auc_roc, metrics.dsr, metrics.pbo, metrics.n_samples,
    )

    return DeploymentGateResult(
        approved=True,
        permission_level=level,
        rejection_reasons=[],
        warnings=warnings,
    )
