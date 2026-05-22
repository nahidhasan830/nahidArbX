"""Job entrypoint — self-contained LightGBM training pipeline.

Replaces the old Optuna sweep entry point. Runs as a Cloud Run Job:
  1. Load settled bets with ML features from Postgres
  2. Check cold-start threshold
  3. Train LightGBM via CPCV
  4. Run deployment gate: check quality gates +
     determine permission level
  5. If deployment gate approves:
     export as ONNX, upload to GCS, write ml_models row
  6. If rejected: write audit row with rejection reasons
  7. Exit
"""

from __future__ import annotations

import logging
import os
import sys
import time

from .config import get_settings
from .db import open_session
from .progress import write_progress


def _count_placed_settled(session) -> int:
    """Count placed bets that have settled — needed for stake_increase gate."""
    from sqlalchemy import text

    result = session.execute(text("""
        SELECT count(*) FROM bets
        WHERE placed_at IS NOT NULL
          AND outcome <> 'pending'
          AND outcome <> 'void'
    """))
    return int(result.scalar() or 0)


def _fail_pending_models(reason: str) -> None:
    """Mark pending ml_models rows as failed so the UI doesn't stay stuck.

    Scoped to TRAINING_MODEL_ID when available so we
    only fail the specific model row for THIS training run. Without
    scoping, concurrent training runs could accidentally clobber each
    other's rows.
    """
    session = open_session()
    try:
        import json
        from sqlalchemy import text as sqla_text

        # pg8000 needs an explicit JSON string, not a Python list
        reasons_json = json.dumps([reason])

        training_model_id = os.environ.get("TRAINING_MODEL_ID")
        if training_model_id:
            # Scoped update: only this run's model row
            session.execute(sqla_text("""
                UPDATE ml_models
                SET status = 'failed',
                    rejection_reasons = CAST(:reasons AS jsonb),
                    training_completed_at = now(),
                    training_stage = 'failed',
                    progress_message = :reason,
                    last_heartbeat_at = now(),
                    estimated_time_remaining_ms = 0
                WHERE status = 'training'
                  AND id = :model_id
            """), {
                "reasons": reasons_json,
                "reason": reason,
                "model_id": training_model_id,
            })
        else:
            # Fallback: update all training rows (backward compat)
            session.execute(sqla_text("""
                UPDATE ml_models
                SET status = 'failed',
                    rejection_reasons = CAST(:reasons AS jsonb),
                    training_completed_at = now(),
                    training_stage = 'failed',
                    progress_message = :reason,
                    last_heartbeat_at = now(),
                    estimated_time_remaining_ms = 0
                WHERE status = 'training'
            """), {"reasons": reasons_json, "reason": reason})
        session.commit()
    except Exception as e:
        logging.getLogger("ml.job").warning("Failed to update ml_models: %s", e)
        session.rollback()
    finally:
        session.close()


def _set_training_stage(
    model_id: str | None,
    stage: str,
    message: str,
    estimated_ms: int = 0,
) -> None:
    session = open_session()
    try:
        write_progress(session, model_id, stage, message, estimated_ms)
    except Exception as e:
        logging.getLogger("ml.job").warning("Failed to write progress: %s", e)
        session.rollback()
    finally:
        session.close()


def main() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=settings.log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log = logging.getLogger("ml.job")
    log.info("ML training job starting")

    start_time = time.monotonic()

    try:
        _run_pipeline(settings, log, start_time)
    except SystemExit:
        raise  # Don't catch sys.exit() calls
    except Exception as exc:
        # ── Catch-all: mark training rows as failed so the UI never stays stuck ──
        reason = f"Unexpected error in training pipeline: {exc}"
        log.error(reason, exc_info=True)
        _fail_pending_models(reason)
        sys.exit(1)


def _run_pipeline(settings, log, start_time: float) -> None:
    """Inner pipeline logic — separated so main() can wrap it with a catch-all."""

    # ── Stale-image preflight ──────────────────────────────────────────
    # The TypeScript trigger passes EXPECTED_FEATURE_VERSION as an env var
    # override when calling runJob(). If the deployed image's FEATURE_VERSION
    # doesn't match, fail fast instead of wasting time loading 0 vectors.
    from .feature_names import FEATURE_VERSION as _IMAGE_FV

    expected_fv = os.environ.get("EXPECTED_FEATURE_VERSION")
    if expected_fv is not None:
        try:
            expected_int = int(expected_fv)
        except ValueError:
            expected_int = -1
        if expected_int != _IMAGE_FV:
            reason = (
                f"STALE IMAGE: trigger expects FEATURE_VERSION={expected_int} "
                f"but deployed image has FEATURE_VERSION={_IMAGE_FV}. "
                f"Rebuild and redeploy: bash services/optimizer/redeploy.sh"
            )
            log.error(reason)
            _fail_pending_models(reason)
            sys.exit(1)
        log.info("Feature version handshake OK: %d", _IMAGE_FV)
    else:
        log.warning(
            "No EXPECTED_FEATURE_VERSION env var — skipping stale-image check "
            "(trigger may be outdated)"
        )

    # ── Load training data ─────────────────────────────────────────────
    from .loader import load_best_available

    session = open_session()
    try:
        data = load_best_available(session)
    finally:
        session.close()

    if data.n_samples < settings.ml_cold_start_threshold:
        log.info(
            "Cold start: only %d samples, need %d. Skipping training.",
            data.n_samples, settings.ml_cold_start_threshold,
        )
        _fail_pending_models(
            f"Cold start: {data.n_samples} samples, need {settings.ml_cold_start_threshold}"
        )
        sys.exit(0)

    log.info(
        "Loaded %d training samples (%d positive, %d negative, scale_pos_weight=%s, sample_weights=%s)",
        data.n_samples, int(data.labels.sum()), int((data.labels == 0).sum()),
        data.scale_pos_weight, "yes" if data.sample_weights is not None else "no",
    )
    _set_training_stage(
        os.environ.get("TRAINING_MODEL_ID"),
        "loading",
        f"Loading dataset: {data.n_samples} samples, {data.features.shape[1]} features",
        5_000,
    )

    # ── Train ──────────────────────────────────────────────────────────
    from .trainer import train

    training_model_id = os.environ.get("TRAINING_MODEL_ID")
    result = train(
        data,
        calibration_method="isotonic",
        progress_callback=lambda stage, message, eta=0: _set_training_stage(
            training_model_id,
            stage,
            message,
            eta,
        ),
    )
    metrics = result.metrics

    log.info(
        "Training complete: AUC=%.4f, DSR=%.4f, PBO=%.4f, ROI=%.2f%%, "
        "policyROI=%.2f%%, policyN=%d, CLV=%.2f%%, CalErr=%.6f, BucketMono=%.2f",
        metrics.auc_roc, metrics.dsr, metrics.pbo,
        metrics.oos_roi_mean, metrics.policy_roi_mean, metrics.policy_sample_size,
        metrics.oos_clv_mean, metrics.calibration_error,
        metrics.score_bucket_report.roi_monotonicity if metrics.score_bucket_report else 0.0,
    )

    # ── Deployment gate ────────────────────────────────────────────────
    from .deployment_gate import evaluate_deployment_gate
    from .feature_names import FEATURE_COUNT, FEATURE_VERSION

    session = open_session()
    try:
        n_placed_settled = _count_placed_settled(session)
    finally:
        session.close()

    gate_result = evaluate_deployment_gate(
        metrics,
        n_placed_settled=n_placed_settled,
        feature_version_matches=data.feature_version == FEATURE_VERSION,
        feature_count_matches=len(data.feature_names) == FEATURE_COUNT,
    )
    _set_training_stage(
        os.environ.get("TRAINING_MODEL_ID"),
        "gate",
        (
            f"Gate approved: {gate_result.permission_level}"
            if gate_result.approved
            else f"Gate rejected: {gate_result.rejection_reasons[0] if gate_result.rejection_reasons else 'policy checks failed'}"
        ),
        0,
    )

    if gate_result.warnings:
        for w in gate_result.warnings:
            log.info("Deployment gate warning: %s", w)

    if not gate_result.approved:
        log.warning(
            "Model REJECTED by deployment gate (%d reasons)",
            len(gate_result.rejection_reasons),
        )
        for reason in gate_result.rejection_reasons:
            log.warning("  - %s", reason)

        # Write audit row with rejection reasons
        session = open_session()
        try:
            from .exporter import write_model_row, get_next_version

            version = get_next_version(session)
            write_model_row(
                session, version, metrics, None,
                deploy=False,
                permission_level=gate_result.permission_level,
                rejection_reasons=gate_result.rejection_reasons,
            )
        finally:
            session.close()

        elapsed = time.monotonic() - start_time
        log.info("Job finished (model rejected) in %.1fs", elapsed)
        sys.exit(0)

    # ── Export + deploy ────────────────────────────────────────────────
    log.info(
        "Deployment gate APPROVED: permission_level=%s",
        gate_result.permission_level,
    )

    from .exporter import export_and_upload

    session = open_session()
    try:
        _set_training_stage(
            os.environ.get("TRAINING_MODEL_ID"),
            "export",
            "Exporting candidate model",
            0,
        )
        model_id = export_and_upload(
            result.model, metrics, session,
            permission_level=gate_result.permission_level,
        )
    finally:
        session.close()

    elapsed = time.monotonic() - start_time
    log.info(
        "Job finished successfully in %.1fs: model_id=%s, permission_level=%s, AUC=%.4f, DSR=%.4f",
        elapsed, model_id, gate_result.permission_level, metrics.auc_roc, metrics.dsr,
    )


if __name__ == "__main__":
    main()
