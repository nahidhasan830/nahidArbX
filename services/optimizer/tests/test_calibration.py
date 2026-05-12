"""Calibration selection tests."""

from __future__ import annotations

import numpy as np

from app.calibration import (
    apply_calibration,
    fit_calibrator,
    fit_calibrator_with_validation,
    method_for_refit,
)


def _binary_log_loss(labels: np.ndarray, probs: np.ndarray) -> float:
    p = np.clip(probs.astype(np.float64), 1e-7, 1 - 1e-7)
    y = labels.astype(np.float64)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def test_auto_calibration_uses_held_out_log_loss_to_avoid_isotonic_plateau():
    """Auto mode should not blindly choose isotonic on large samples."""
    rng = np.random.default_rng(7)
    base_probs = rng.uniform(0.05, 0.75, 780)
    top_probs = rng.uniform(0.86, 0.95, 60)
    fit_probs = np.concatenate([base_probs, top_probs])
    fit_labels = np.concatenate([
        (rng.random(base_probs.size) < base_probs).astype(np.int32),
        np.ones(top_probs.size, dtype=np.int32),
    ])

    # Later data contradicts the high-probability plateau. This is the exact
    # failure mode that produced a good ECE but bad deployment-gate log loss.
    eval_probs = np.array([0.88, 0.91, 0.94, 0.22, 0.35, 0.48, 0.62, 0.72])
    eval_labels = np.array([0, 0, 0, 0, 0, 1, 1, 1], dtype=np.int32)

    selected = fit_calibrator_with_validation(
        fit_probs,
        fit_labels,
        eval_probs,
        eval_labels,
        method="auto",
    )
    isotonic = fit_calibrator(fit_probs, fit_labels, method="isotonic")

    selected_loss = _binary_log_loss(
        eval_labels,
        apply_calibration(eval_probs, selected),
    )
    isotonic_loss = _binary_log_loss(
        eval_labels,
        apply_calibration(eval_probs, isotonic),
    )

    assert selected.method != "isotonic"
    assert selected_loss < isotonic_loss


def test_method_for_refit_maps_platt_result_to_fit_method():
    cal = fit_calibrator(
        np.array([0.2] * 12 + [0.8] * 12),
        np.array([0] * 12 + [1] * 12),
        method="platt",
    )

    assert cal.method == "platt_logit"
    assert method_for_refit(cal) == "platt"
