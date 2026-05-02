"""Job entrypoint — self-contained LightGBM training pipeline.

Replaces the old Optuna sweep entry point. Runs as a Cloud Run Job:
  1. Load settled bets with ML features from Postgres
  2. Check cold-start threshold
  3. Train LightGBM via CPCV
  4. If quality gates pass (DSR > threshold, PBO < threshold):
     export as ONNX, upload to GCS, write ml_models row
  5. Exit
"""

from __future__ import annotations

import logging
import sys
import time

from .config import get_settings
from .db import open_session


def main() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=settings.log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log = logging.getLogger("ml.job")
    log.info("ML training job starting")

    start_time = time.monotonic()

    # ── Load training data ─────────────────────────────────────────────
    from .loader import load_training_data

    session = open_session()
    try:
        data = load_training_data(session)
    finally:
        session.close()

    if data.n_samples < settings.ml_cold_start_threshold:
        log.info(
            "Cold start: only %d samples, need %d. Skipping training.",
            data.n_samples, settings.ml_cold_start_threshold,
        )
        sys.exit(0)

    log.info(
        "Loaded %d training samples (%d positive, %d negative)",
        data.n_samples, int(data.labels.sum()), int((data.labels == 0).sum()),
    )

    # ── Train ──────────────────────────────────────────────────────────
    from .trainer import train

    result = train(data)
    metrics = result.metrics

    log.info(
        "Training complete: AUC=%.4f, DSR=%.4f, PBO=%.4f, ROI=%.2f%%, CalErr=%.6f",
        metrics.auc_roc, metrics.dsr, metrics.pbo,
        metrics.oos_roi_mean, metrics.calibration_error,
    )

    # ── Quality gate ───────────────────────────────────────────────────
    if metrics.dsr < settings.ml_min_dsr or metrics.pbo > settings.ml_max_pbo:
        log.warning(
            "Model REJECTED: DSR=%.4f (need >%.2f), PBO=%.4f (need <%.2f)",
            metrics.dsr, settings.ml_min_dsr, metrics.pbo, settings.ml_max_pbo,
        )
        # Still write a row with status='validated' (not deployed) so we
        # have an audit trail of rejected models.
        session = open_session()
        try:
            from .exporter import write_model_row, get_next_version

            version = get_next_version(session)
            write_model_row(session, version, metrics, None, deploy=False)
        finally:
            session.close()

        elapsed = time.monotonic() - start_time
        log.info("Job finished (model rejected) in %.1fs", elapsed)
        sys.exit(0)

    # ── Export + deploy ────────────────────────────────────────────────
    from .exporter import export_and_upload

    session = open_session()
    try:
        model_id = export_and_upload(result.model, metrics, session)
    finally:
        session.close()

    elapsed = time.monotonic() - start_time
    log.info(
        "Job finished successfully in %.1fs: model_id=%s, AUC=%.4f, DSR=%.4f",
        elapsed, model_id, metrics.auc_roc, metrics.dsr,
    )


if __name__ == "__main__":
    main()
