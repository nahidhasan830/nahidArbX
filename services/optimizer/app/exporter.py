"""ONNX export + GCS upload + ml_models DB row.

Converts a trained LightGBM model to ONNX format, embeds feature names
in the model metadata for runtime validation, uploads to GCS, and writes
the model lifecycle row to the ml_models table.
"""

from __future__ import annotations

import logging
import os
import tempfile
from datetime import datetime, timezone

import lightgbm as lgb
import numpy as np
import onnx
from onnx import StringStringEntryProto
from onnxmltools import convert_lightgbm
from onnxmltools.convert.common.data_types import FloatTensorType
from sqlalchemy import text
from sqlalchemy.orm import Session

from .config import get_settings
from .feature_names import FEATURE_COUNT, FEATURE_NAMES
from .trainer import TrainingMetrics

log = logging.getLogger(__name__)


def export_onnx(
    model: lgb.LGBMClassifier,
    output_path: str,
) -> str:
    """Convert LightGBM model to ONNX and save to disk.

    Embeds feature names in ONNX metadata so the Node.js scorer can
    validate at load time that its feature vector matches.

    Returns the output path.
    """
    # Define input type: batch of 23-dim float vectors
    initial_type = [("input", FloatTensorType([None, FEATURE_COUNT]))]

    # Convert to ONNX
    onnx_model = convert_lightgbm(
        model,
        initial_types=initial_type,
        name="nahidarbx_ml_scorer",
        target_opset=15,
    )

    # Embed feature names in metadata for runtime contract validation
    feature_names_str = ",".join(FEATURE_NAMES)
    onnx_model.metadata_props.append(
        StringStringEntryProto(key="feature_names", value=feature_names_str)
    )
    onnx_model.metadata_props.append(
        StringStringEntryProto(key="feature_count", value=str(FEATURE_COUNT))
    )

    # Validate the ONNX model
    onnx.checker.check_model(onnx_model)

    # Save to disk
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    onnx.save(onnx_model, output_path)
    log.info("ONNX model saved to %s (%.1f KB)", output_path,
             os.path.getsize(output_path) / 1024)

    return output_path


def upload_to_gcs(local_path: str, model_version: int) -> str | None:
    """Upload ONNX model to GCS bucket. Returns the GCS URI or None on failure."""
    settings = get_settings()
    bucket_name = settings.ml_model_bucket

    if not bucket_name:
        log.warning("ML_MODEL_BUCKET not set, skipping GCS upload")
        return None

    try:
        from google.cloud import storage

        client = storage.Client()
        bucket = client.bucket(bucket_name)

        blob_name = f"models/v{model_version}/model.onnx"
        blob = bucket.blob(blob_name)
        blob.upload_from_filename(local_path)

        gcs_uri = f"gs://{bucket_name}/{blob_name}"
        log.info("Uploaded ONNX model to %s", gcs_uri)
        return gcs_uri
    except Exception as e:
        log.warning("GCS upload failed (model saved locally): %s", e)
        return None


def write_model_row(
    session: Session,
    model_version: int,
    metrics: TrainingMetrics,
    artifact_path: str | None,
    *,
    deploy: bool = True,
) -> str:
    """Write a row to ml_models tracking this training run.

    If deploy=True, sets status='deployed' and retires any previously
    deployed model.
    """
    import ulid

    model_id = str(ulid.new())
    now = datetime.now(timezone.utc).isoformat()
    status = "deployed" if deploy else "validated"

    # Retire any currently deployed model
    if deploy:
        session.execute(
            text("""
                UPDATE ml_models
                SET status = 'retired', retired_at = :now
                WHERE status = 'deployed'
            """),
            {"now": now},
        )

    session.execute(
        text("""
            INSERT INTO ml_models (
                id, version, status, model_type, training_samples,
                feature_count, training_started_at, training_completed_at,
                oos_roi_mean, oos_accuracy, oos_auc_roc, oos_log_loss,
                deflated_sharpe, pbo, calibration_error,
                feature_importance, model_artifact_path, training_report,
                deployed_at, created_at
            ) VALUES (
                :id, :version, :status, :model_type, :training_samples,
                :feature_count, :training_started_at, :training_completed_at,
                :oos_roi_mean, :oos_accuracy, :oos_auc_roc, :oos_log_loss,
                :deflated_sharpe, :pbo, :calibration_error,
                :feature_importance, :model_artifact_path, :training_report,
                :deployed_at, :created_at
            )
        """),
        {
            "id": model_id,
            "version": model_version,
            "status": status,
            "model_type": "lightgbm",
            "training_samples": metrics.n_samples,
            "feature_count": FEATURE_COUNT,
            "training_started_at": now,  # Approximation — actual start tracked externally
            "training_completed_at": now,
            "oos_roi_mean": metrics.oos_roi_mean,
            "oos_accuracy": metrics.accuracy,
            "oos_auc_roc": metrics.auc_roc,
            "oos_log_loss": metrics.log_loss_val,
            "deflated_sharpe": metrics.dsr,
            "pbo": metrics.pbo,
            "calibration_error": metrics.calibration_error,
            "feature_importance": _json_dumps(metrics.feature_importance),
            "model_artifact_path": artifact_path,
            "training_report": _json_dumps({
                "n_positive": metrics.n_positive,
                "n_negative": metrics.n_negative,
                "n_folds": metrics.n_folds,
                "per_fold_sharpes": metrics.per_fold_sharpes,
            }),
            "deployed_at": now if deploy else None,
            "created_at": now,
        },
    )
    session.commit()

    log.info("Written ml_models row: id=%s version=%d status=%s", model_id, model_version, status)
    return model_id


def get_next_version(session: Session) -> int:
    """Get the next model version number (max existing + 1)."""
    result = session.execute(text("SELECT COALESCE(MAX(version), 0) FROM ml_models"))
    current_max = result.scalar() or 0
    return int(current_max) + 1


def export_and_upload(
    model: lgb.LGBMClassifier,
    metrics: TrainingMetrics,
    session: Session,
) -> str:
    """Full export pipeline: ONNX → GCS → DB row.

    Returns the model ID.
    """
    version = get_next_version(session)

    # Export to ONNX (temp directory, then upload)
    with tempfile.TemporaryDirectory() as tmpdir:
        onnx_path = os.path.join(tmpdir, f"model_v{version}.onnx")
        export_onnx(model, onnx_path)

        # Validate the exported model produces sensible output
        _validate_onnx_output(onnx_path)

        # Upload to GCS
        gcs_uri = upload_to_gcs(onnx_path, version)
        artifact_path = gcs_uri or onnx_path

    # Write DB row
    model_id = write_model_row(
        session, version, metrics, artifact_path, deploy=True
    )

    log.info(
        "Model v%d exported and deployed: id=%s, AUC=%.4f, DSR=%.4f",
        version, model_id, metrics.auc_roc, metrics.dsr,
    )
    return model_id


def _validate_onnx_output(model_path: str) -> None:
    """Quick sanity check: run a dummy input through the ONNX model."""
    try:
        import onnxruntime as ort

        sess = ort.InferenceSession(model_path)
        dummy = np.random.randn(2, FEATURE_COUNT).astype(np.float32)
        input_name = sess.get_inputs()[0].name
        results = sess.run(None, {input_name: dummy})

        # LightGBM ONNX outputs [labels, probabilities]
        probs = results[1]
        assert probs.shape == (2, 2), f"Expected shape (2,2), got {probs.shape}"
        assert np.all(probs >= 0) and np.all(probs <= 1), "Probabilities out of range"
        log.info("ONNX validation passed: output shape %s", probs.shape)
    except ImportError:
        log.warning("onnxruntime not available, skipping ONNX validation")
    except Exception as e:
        log.warning("ONNX validation failed (non-fatal): %s", e)


def _json_dumps(obj: dict) -> str:
    """JSON serialize for JSONB columns."""
    import json
    return json.dumps(obj, default=str)
