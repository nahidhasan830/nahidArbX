"""Probability calibration for binary classifiers.

Implements the three calibration methods that production ML uses for
boosted-tree classifiers, with sample-size-based automatic selection:

  - Platt (sigmoid)   : 2-parameter; safest with very few samples
  - Beta              : 3-parameter; better than Platt at small/medium n
  - Isotonic          : non-parametric; dominates above ~1000 samples

References:
  - Niculescu-Mizil & Caruana, "Predicting Good Probabilities with
    Supervised Learning" (ICML 2005).
  - sklearn calibration docs: isotonic outperforms sigmoid above ~1000.
  - Kull, Filho, Flach, "Beta calibration: a well-founded and easily
    implemented improvement on logistic calibration for binary classifiers".

The fitted calibrator must serialize to a JSON-friendly dict so the
Node.js scorer can apply the inverse transform without depending on
sklearn at runtime.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass

import numpy as np
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import log_loss

log = logging.getLogger(__name__)


# Sample-size thresholds for auto-selection. Tuned to the literature:
#   < 500  : Platt (low-variance, won't overfit)
#   500-1k : Beta (parametric but flexible enough)
#   ≥ 1000 : Isotonic (non-parametric is preferred at this scale)
_PLATT_MAX_N = 500
_BETA_MAX_N = 1000


@dataclass
class CalibrationResult:
    """Calibration fit. JSON-serializable for runtime consumption."""

    method: str  # "platt_logit" | "beta" | "isotonic" | "identity"
    params: dict
    """Method-specific parameters.

    platt_logit : {"intercept": float, "slope": float}
    beta        : {"a": float, "b": float, "c": float}
    isotonic    : {"x": list[float], "y": list[float]} (PAV step function)
    identity    : {} (no transform)
    """


def fit_calibrator(
    raw_probs: np.ndarray,
    labels: np.ndarray,
    *,
    method: str = "auto",
) -> CalibrationResult:
    """Fit a 1-D calibrator from OOS predictions to true labels.

    Args:
      raw_probs: P(positive) from the uncalibrated model, shape (n,).
      labels:    binary {0, 1} labels, shape (n,).
      method:    "auto" | "platt" | "beta" | "isotonic" | "identity"

    Returns:
      CalibrationResult — JSON-serializable.
    """
    n = len(raw_probs)
    if n < 20 or len(np.unique(labels)) < 2:
        log.info("Calibration skipped: insufficient data or single class")
        return CalibrationResult(method="identity", params={})

    chosen = _choose_method(method, n)

    if chosen == "platt":
        return _fit_platt(raw_probs, labels)
    if chosen == "beta":
        return _fit_beta(raw_probs, labels)
    if chosen == "isotonic":
        return _fit_isotonic(raw_probs, labels)
    return CalibrationResult(method="identity", params={})


def fit_calibrator_with_validation(
    fit_probs: np.ndarray,
    fit_labels: np.ndarray,
    eval_probs: np.ndarray,
    eval_labels: np.ndarray,
    *,
    method: str = "auto",
) -> CalibrationResult:
    """Fit a calibrator, selecting auto mode by held-out log loss.

    Isotonic calibration is powerful, but on betting data it can create hard
    0/1 probability plateaus. A small number of later losses in that plateau
    can explode deployment-gate log loss while ECE still looks acceptable. In
    auto mode, fit candidate calibrators on the calibration-fit slice and pick
    the one with the best held-out log loss on the calibration-eval slice.
    """
    if method.lower() != "auto":
        return fit_calibrator(fit_probs, fit_labels, method=method)

    if (
        len(fit_probs) < 20
        or len(eval_probs) == 0
        or len(np.unique(fit_labels)) < 2
        or len(np.unique(eval_labels)) < 2
    ):
        return fit_calibrator(fit_probs, fit_labels, method="identity")

    n_fit = len(fit_probs)
    candidates = ["identity", "platt"]
    if n_fit >= 200:
        candidates.append("beta")
    if n_fit >= 800:
        candidates.append("isotonic")

    best: tuple[float, str, CalibrationResult] | None = None
    for candidate in candidates:
        cal = fit_calibrator(fit_probs, fit_labels, method=candidate)
        calibrated = apply_calibration(eval_probs, cal)
        try:
            ll = float(
                log_loss(
                    eval_labels,
                    np.clip(calibrated, 1e-7, 1 - 1e-7),
                    labels=[0, 1],
                )
            )
        except ValueError:
            ll = float("inf")
        if best is None or ll < best[0]:
            best = (ll, candidate, cal)

    assert best is not None
    log.info(
        "Calibration auto-selected %s by held-out log loss %.6f",
        best[2].method,
        best[0],
    )
    return best[2]


def method_for_refit(calibration: CalibrationResult) -> str:
    """Return the explicit fit_calibrator method for a selected result."""
    if calibration.method == "platt_logit":
        return "platt"
    return calibration.method


def apply_calibration(
    raw_probs: np.ndarray,
    calibration: CalibrationResult,
) -> np.ndarray:
    """Apply a fitted calibrator to a batch of raw probabilities.

    Mirrors the runtime transform used by the Node.js scorer.
    """
    method = calibration.method
    if method == "identity":
        return raw_probs.astype(np.float64)
    if method == "platt_logit":
        return _apply_platt(raw_probs, calibration.params)
    if method == "beta":
        return _apply_beta(raw_probs, calibration.params)
    if method == "isotonic":
        return _apply_isotonic(raw_probs, calibration.params)
    log.warning("Unknown calibration method %s, returning identity", method)
    return raw_probs.astype(np.float64)


# ── Method selection ───────────────────────────────────────────────────────


def _choose_method(method: str, n: int) -> str:
    method = method.lower()
    if method != "auto":
        return method
    if n < _PLATT_MAX_N:
        return "platt"
    if n < _BETA_MAX_N:
        return "beta"
    return "isotonic"


# ── Platt (sigmoid) ────────────────────────────────────────────────────────


def _fit_platt(probs: np.ndarray, labels: np.ndarray) -> CalibrationResult:
    clipped = np.clip(probs.astype(np.float64), 1e-6, 1 - 1e-6)
    logits = np.log(clipped / (1.0 - clipped)).reshape(-1, 1)
    try:
        lr = LogisticRegression(solver="lbfgs", C=1.0, max_iter=1000)
        lr.fit(logits, labels)
        slope = float(lr.coef_[0][0])
        intercept = float(lr.intercept_[0])
        if not math.isfinite(slope) or not math.isfinite(intercept):
            raise ValueError("non-finite Platt parameters")
        return CalibrationResult(
            method="platt_logit",
            params={"intercept": intercept, "slope": slope},
        )
    except Exception as exc:
        log.warning("Platt calibration failed (%s) — falling back to identity", exc)
        return CalibrationResult(method="identity", params={})


def _apply_platt(probs: np.ndarray, params: dict) -> np.ndarray:
    clipped = np.clip(probs.astype(np.float64), 1e-6, 1 - 1e-6)
    logits = np.log(clipped / (1.0 - clipped))
    z = float(params.get("intercept", 0.0)) + float(params.get("slope", 1.0)) * logits
    z = np.clip(z, -35.0, 35.0)
    return 1.0 / (1.0 + np.exp(-z))


# ── Beta calibration ───────────────────────────────────────────────────────
#
# Kull, Filho & Flach (2017): a well-founded 3-parameter calibrator that
# strictly generalises Platt scaling. The mapping is:
#
#     calibrated = sigmoid( a*log(p) - b*log(1-p) + c )
#
# We fit (a, b, c) by logistic regression on transformed features
# log(p) and log(1-p), with c as the intercept.


def _fit_beta(probs: np.ndarray, labels: np.ndarray) -> CalibrationResult:
    p = np.clip(probs.astype(np.float64), 1e-6, 1 - 1e-6)
    log_p = np.log(p)
    log_1mp = np.log(1.0 - p)
    # Beta needs feature matrix [log(p), -log(1-p)] so coefs are (a, b)
    X = np.column_stack([log_p, -log_1mp])
    try:
        lr = LogisticRegression(solver="lbfgs", C=1.0, max_iter=1000)
        lr.fit(X, labels)
        a = float(lr.coef_[0][0])
        b = float(lr.coef_[0][1])
        c = float(lr.intercept_[0])
        if not all(math.isfinite(v) for v in (a, b, c)):
            raise ValueError("non-finite beta parameters")
        return CalibrationResult(
            method="beta",
            params={"a": a, "b": b, "c": c},
        )
    except Exception as exc:
        log.warning("Beta calibration failed (%s) — falling back to Platt", exc)
        return _fit_platt(probs, labels)


def _apply_beta(probs: np.ndarray, params: dict) -> np.ndarray:
    a = float(params.get("a", 1.0))
    b = float(params.get("b", 1.0))
    c = float(params.get("c", 0.0))
    p = np.clip(probs.astype(np.float64), 1e-6, 1 - 1e-6)
    z = a * np.log(p) - b * np.log(1.0 - p) + c
    z = np.clip(z, -35.0, 35.0)
    return 1.0 / (1.0 + np.exp(-z))


# ── Isotonic regression ────────────────────────────────────────────────────


def _fit_isotonic(probs: np.ndarray, labels: np.ndarray) -> CalibrationResult:
    try:
        ir = IsotonicRegression(out_of_bounds="clip", y_min=0.05, y_max=0.95)
        ir.fit(probs.astype(np.float64), labels.astype(np.float64))
        # Persist the step function as parallel arrays so the Node scorer
        # can do constant-time interpolation without a sklearn dep.
        x_thresholds = ir.X_thresholds_.tolist()
        y_thresholds = ir.y_thresholds_.tolist()
        if not x_thresholds or len(x_thresholds) != len(y_thresholds):
            raise ValueError("empty isotonic fit")
        return CalibrationResult(
            method="isotonic",
            params={"x": x_thresholds, "y": y_thresholds},
        )
    except Exception as exc:
        log.warning("Isotonic calibration failed (%s) — falling back to beta", exc)
        return _fit_beta(probs, labels)


def _apply_isotonic(probs: np.ndarray, params: dict) -> np.ndarray:
    xs = np.asarray(params.get("x", []), dtype=np.float64)
    ys = np.asarray(params.get("y", []), dtype=np.float64)
    if xs.size == 0 or xs.size != ys.size:
        return probs.astype(np.float64)
    p = probs.astype(np.float64)
    # np.interp does linear interpolation; isotonic is piecewise-linear in
    # sklearn's representation so this is the correct inverse.
    out = np.interp(p, xs, ys, left=ys[0], right=ys[-1])
    return np.clip(out, 0.05, 0.95)
