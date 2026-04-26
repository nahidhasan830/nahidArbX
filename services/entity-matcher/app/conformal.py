"""Conformal-prediction calibration wrapper.

Cross-encoder logits aren't probabilities — a "score 0.85" doesn't mean
"85% likely the same team". Conformal prediction (via MAPIE) gives us a
formal guarantee: if we promote at p-value <= 0.05, the long-run error
rate is bounded at 5%.

Calibration data comes from operator-confirmed pairs in name_observations.
On a fresh deploy with no calibration data we return p=0.5 for everything,
which forces the auto-resolver to escalate to operator inbox until the
first weekly trainer run lands real calibration weights.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import joblib
import numpy as np

log = logging.getLogger("entity-matcher.conformal")

# Default location matches what the trainer Job writes.
ARTEFACT_DIR = Path(os.getenv("ARTEFACT_DIR", "/var/lib/entity-matcher"))
CALIBRATOR_PATH = ARTEFACT_DIR / "conformal_calibrator.joblib"
META_PATH = ARTEFACT_DIR / "calibrator_meta.json"

_lock = threading.Lock()
_calibrator: Optional["ConformalCalibrator"] = None


@dataclass
class CalibratedPrediction:
    score: float
    pvalue: float
    model_version: str


class ConformalCalibrator:
    """Wraps a precomputed nonconformity-score distribution.

    The trainer Job collects raw cross-encoder scores on a held-out
    validation set with known labels, sorts them, and saves the
    distribution. At inference we compute the p-value as the fraction of
    calibration points whose nonconformity score is greater than or equal
    to the new observation's score.
    """

    def __init__(
        self,
        positive_scores: np.ndarray,
        negative_scores: np.ndarray,
        model_version: str,
    ) -> None:
        self.positive_scores = np.sort(positive_scores)
        self.negative_scores = np.sort(negative_scores)
        self.model_version = model_version

    def pvalue(self, raw_score: float) -> float:
        """Two-sided p-value over the negative-class distribution.

        Low p-value => raw_score is far from the typical negative score
        => high confidence that this pair IS a positive (same entity).
        """
        if self.negative_scores.size == 0:
            return 0.5
        # Empirical p-value: fraction of negatives that scored >= raw_score.
        idx = np.searchsorted(self.negative_scores, raw_score, side="left")
        rank_above = self.negative_scores.size - idx
        return float((rank_above + 1) / (self.negative_scores.size + 1))

    def predict(self, raw_score: float) -> CalibratedPrediction:
        return CalibratedPrediction(
            score=float(raw_score),
            pvalue=self.pvalue(raw_score),
            model_version=self.model_version,
        )


def _uncalibrated() -> ConformalCalibrator:
    """Fallback when the trainer hasn't produced a calibrator yet."""
    return ConformalCalibrator(
        positive_scores=np.array([], dtype=np.float32),
        negative_scores=np.array([], dtype=np.float32),
        model_version="uncalibrated",
    )


def get_calibrator() -> ConformalCalibrator:
    global _calibrator
    if _calibrator is not None:
        return _calibrator
    with _lock:
        if _calibrator is None:
            _calibrator = _load_or_default()
    return _calibrator


def _load_or_default() -> ConformalCalibrator:
    if not CALIBRATOR_PATH.exists():
        log.info("No calibrator artefact at %s; using uncalibrated (p=0.5)", CALIBRATOR_PATH)
        return _uncalibrated()
    try:
        bundle = joblib.load(CALIBRATOR_PATH)
        version = "unknown"
        if META_PATH.exists():
            meta = json.loads(META_PATH.read_text())
            version = meta.get("model_version", "unknown")
        log.info("Loaded calibrator %s with %d positive / %d negative samples",
                 version, len(bundle["positive_scores"]), len(bundle["negative_scores"]))
        return ConformalCalibrator(
            positive_scores=np.asarray(bundle["positive_scores"], dtype=np.float32),
            negative_scores=np.asarray(bundle["negative_scores"], dtype=np.float32),
            model_version=version,
        )
    except Exception as exc:  # pragma: no cover — degrade gracefully
        log.exception("Failed to load calibrator; falling back to uncalibrated: %s", exc)
        return _uncalibrated()


def reload_calibrator() -> ConformalCalibrator:
    """Force a re-read of the artefact files. Trainer Job calls /reload
    after publishing fresh weights."""
    global _calibrator
    with _lock:
        _calibrator = _load_or_default()
    return _calibrator
