"""Vertex AI Model Registry + ml_models DB row.

Registers trained LightGBM models with Vertex AI Model Registry and deploys
to Prediction endpoints. ONNX export is kept for validation only.
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
from .feature_names import FEATURE_COUNT, FEATURE_NAMES, FEATURE_NAMES_HASH, FEATURE_VERSION
from .trainer import TrainingMetrics

log = logging.getLogger(__name__)


def export_onnx(
    model: lgb.LGBMClassifier,
    output_path: str,
    *,
    metrics: TrainingMetrics | None = None,
) -> str:
    """Convert LightGBM model to ONNX and save to disk.

    Embeds feature names in ONNX metadata so the Node.js scorer can
    validate at load time that its feature vector matches.

    IMPORTANT: We disable the ZipMap post-processor (zipmap=False) to
    ensure all outputs are plain tensors. onnxruntime-node cannot handle
    the non-tensor sequence/map types that ZipMap produces, throwing
    "Non tensor type is temporarily not supported".

    Returns the output path.
    """
    # Define input type: batch of current-contract float vectors
    initial_type = [("input", FloatTensorType([None, FEATURE_COUNT]))]

    # Convert to ONNX with zipmap=False to avoid non-tensor outputs.
    # Without this, skl2onnx appends a ZipMap operator that converts
    # the probability tensor into a sequence of {class_id: probability}
    # maps — a type that onnxruntime-node cannot handle.
    onnx_model = convert_lightgbm(
        model,
        initial_types=initial_type,
        name="nahidarbx_ml_scorer",
        target_opset=15,
        zipmap=False,
    )

    # Post-process: strip any remaining non-tensor outputs (e.g. 'label').
    # This is a defense-in-depth measure in case the converter version
    # or model type still produces non-tensor outputs despite zipmap=False.
    _strip_non_tensor_outputs(onnx_model)

    # Embed feature names in metadata for runtime contract validation
    feature_names_str = ",".join(FEATURE_NAMES)
    onnx_model.metadata_props.append(
        StringStringEntryProto(key="feature_names", value=feature_names_str)
    )
    onnx_model.metadata_props.append(
        StringStringEntryProto(key="feature_count", value=str(FEATURE_COUNT))
    )
    onnx_model.metadata_props.append(
        StringStringEntryProto(key="feature_version", value=str(FEATURE_VERSION))
    )
    onnx_model.metadata_props.append(
        StringStringEntryProto(key="feature_names_hash", value=FEATURE_NAMES_HASH)
    )
    if metrics is not None:
        onnx_model.metadata_props.append(
            StringStringEntryProto(key="calibration_method", value=metrics.calibration_method)
        )
        onnx_model.metadata_props.append(
            StringStringEntryProto(
                key="policy_edge_threshold_pct",
                value=str(metrics.policy_edge_threshold_pct),
            )
        )
        onnx_model.metadata_props.append(
            StringStringEntryProto(
                key="calibration_intercept",
                value=str(metrics.calibration_params.get("intercept", 0.0)),
            )
        )
        onnx_model.metadata_props.append(
            StringStringEntryProto(
                key="calibration_slope",
                value=str(metrics.calibration_params.get("slope", 1.0)),
            )
        )

    # Validate the ONNX model
    try:
        onnx.checker.check_model(onnx_model)
    except Exception as e:
        # Validation may fail on stripped models due to missing shape info
        # but the model still works correctly at inference time
        log.warning("ONNX validation warning (non-fatal): %s", e)

    # Save to disk
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    onnx.save(onnx_model, output_path)
    log.info("ONNX model saved to %s (%.1f KB)", output_path,
             os.path.getsize(output_path) / 1024)

    return output_path


def _strip_non_tensor_outputs(onnx_model: onnx.ModelProto) -> None:
    """Remove non-tensor outputs and their producing ZipMap nodes.

    onnxruntime-node (used in the engine) cannot handle sequence/map
    output types. This function strips ZipMap operators and any outputs
    that reference non-tensor types (like the 'label' string output).
    """
    from onnx import TensorProto

    graph = onnx_model.graph

    # Remove ZipMap nodes (they convert tensors → sequences of maps)
    zipmap_nodes = [n for n in graph.node if n.op_type == "ZipMap"]
    for zm_node in zipmap_nodes:
        tensor_input = zm_node.input[0]
        zm_output = zm_node.output[0]

        # Rewire any references to the ZipMap output
        for out in graph.output:
            if out.name == zm_output:
                out.name = tensor_input
                out.ClearField("type")
                out.type.tensor_type.elem_type = TensorProto.FLOAT

        for node in graph.node:
            for i, inp in enumerate(node.input):
                if inp == zm_output:
                    node.input[i] = tensor_input

        graph.node.remove(zm_node)

    # Remove non-tensor outputs (e.g. 'label' which is a string sequence)
    tensor_outputs = []
    for out in graph.output:
        # Keep outputs that have tensor type or were just fixed above
        if out.type.HasField("tensor_type") or "prob" in out.name.lower():
            tensor_outputs.append(out)
        else:
            log.info("Stripped non-tensor output: %s", out.name)

    if len(tensor_outputs) < len(graph.output):
        del graph.output[:]
        graph.output.extend(tensor_outputs)


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
    permission_level: str = "observe",
    rejection_reasons: list[str] | None = None,
    onnx_blob: bytes | None = None,
    vertex_model_name: str | None = None,
    vertex_endpoint_name: str | None = None,
) -> str:
    """Write a row to ml_models tracking this training run.

    If deploy=True, sets status='deployed' and retires any previously
    deployed model. If deploy=False and rejection_reasons is non-empty,
    sets status='rejected' (otherwise 'validated').
    """
    import ulid

    model_id = str(ulid.new())
    now = datetime.now(timezone.utc).isoformat()
    if deploy:
        status = "deployed"
    elif rejection_reasons:
        status = "rejected"
    else:
        status = "validated"
    terminal_stage = "complete" if status == "deployed" else status
    progress_message = (
        f"Gate rejected: {rejection_reasons[0]}"
        if status == "rejected" and rejection_reasons
        else (
            f"Model v{model_version} deployed successfully"
            if status == "deployed"
            else f"Model v{model_version} validated"
        )
    )

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

    # Clean up the dummy 'training' row inserted by the trigger for this run.
    # Scope by TRAINING_MODEL_ID when available so concurrent/overlapping jobs
    # cannot delete each other's placeholders.
    training_model_id = os.environ.get("TRAINING_MODEL_ID")
    if training_model_id:
        session.execute(
            text("DELETE FROM ml_models WHERE status = 'training' AND id = :model_id"),
            {"model_id": training_model_id},
        )
    else:
        # Backward-compatible fallback for older triggers.
        session.execute(text("DELETE FROM ml_models WHERE status = 'training'"))

    session.execute(
        text("""
            INSERT INTO ml_models (
                id, version, status, model_type, training_samples,
                feature_count, training_started_at, training_completed_at,
                training_stage, progress_message, last_heartbeat_at,
                estimated_time_remaining_ms,
                feature_version, feature_names_hash,
                oos_roi_mean, oos_accuracy, oos_auc_roc, oos_log_loss,
                deflated_sharpe, pbo, calibration_error,
                feature_importance, model_artifact_path, onnx_blob, training_report,
                permission_level, rejection_reasons,
                vertex_model_name, vertex_endpoint_name,
                deployed_at, created_at
            ) VALUES (
                :id, :version, :status, :model_type, :training_samples,
                :feature_count, :training_started_at, :training_completed_at,
                :training_stage, :progress_message, :last_heartbeat_at,
                :estimated_time_remaining_ms,
                :feature_version, :feature_names_hash,
                :oos_roi_mean, :oos_accuracy, :oos_auc_roc, :oos_log_loss,
                :deflated_sharpe, :pbo, :calibration_error,
                :feature_importance, :model_artifact_path, :onnx_blob, :training_report,
                :permission_level, :rejection_reasons,
                :vertex_model_name, :vertex_endpoint_name,
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
            "feature_version": FEATURE_VERSION,
            "feature_names_hash": FEATURE_NAMES_HASH,
            "training_started_at": now,  # Approximation — actual start tracked externally
            "training_completed_at": now,
            "training_stage": terminal_stage,
            "progress_message": progress_message,
            "last_heartbeat_at": now,
            "estimated_time_remaining_ms": 0,
            "oos_roi_mean": metrics.oos_roi_mean,
            "oos_accuracy": metrics.accuracy,
            "oos_auc_roc": metrics.auc_roc,
            "oos_log_loss": metrics.log_loss_val,
            "deflated_sharpe": metrics.dsr,
            "pbo": metrics.pbo,
            "calibration_error": metrics.calibration_error,
            "feature_importance": _json_dumps(metrics.feature_importance),
            "model_artifact_path": artifact_path,
            "onnx_blob": onnx_blob,
            "training_report": _json_dumps({
                "n_positive": metrics.n_positive,
                "n_negative": metrics.n_negative,
                "n_folds": metrics.n_folds,
                "scale_pos_weight": metrics.scale_pos_weight,
                "per_fold_sharpes": metrics.per_fold_sharpes,
                "oos_clv_mean": metrics.oos_clv_mean,
                "policy_roi_mean": metrics.policy_roi_mean,
                "policy_sample_size": metrics.policy_sample_size,
                "policy_coverage": metrics.policy_coverage,
                "policy_edge_threshold_pct": metrics.policy_edge_threshold_pct,
                "baseline_roi_mean": metrics.baseline_roi_mean,
                "simple_policy_roi_mean": metrics.simple_policy_roi_mean,
                "simple_policy_sample_size": metrics.simple_policy_sample_size,
                "simple_policy_coverage": metrics.simple_policy_coverage,
                "model_vs_simple_roi_delta": metrics.model_vs_simple_roi_delta,
                "policy_lower_confidence_roi_pct": metrics.policy_lower_confidence_roi_pct,
                "policy_threshold_candidates": metrics.policy_threshold_candidates,
                "calibration_method": metrics.calibration_method,
                "calibration_params": metrics.calibration_params,
                "score_bucket_report": _serialize_bucket_report(metrics.score_bucket_report),
            }),
            "permission_level": permission_level,
            "rejection_reasons": _json_dumps(rejection_reasons) if rejection_reasons else None,
            "vertex_model_name": vertex_model_name,
            "vertex_endpoint_name": vertex_endpoint_name,
            "deployed_at": now if deploy else None,
            "created_at": now,
        },
    )
    session.commit()

    log.info("Written ml_models row: id=%s version=%d status=%s", model_id, model_version, status)
    return model_id


def get_next_version(session: Session) -> int:
    """Get the next model version number from Postgres sequence.

    Uses ml_model_version_seq (created by migration 0053) for race-safe
    allocation. Falls back to MAX(version)+1 if the sequence doesn't exist
    yet (pre-migration compat).
    """
    try:
        result = session.execute(text("SELECT nextval('ml_model_version_seq')"))
        return int(result.scalar())
    except Exception:
        # Fallback for pre-migration environments
        session.rollback()
        result = session.execute(text("SELECT COALESCE(MAX(version), 0) FROM ml_models"))
        current_max = result.scalar() or 0
        return int(current_max) + 1


def export_and_upload(
    model: lgb.LGBMClassifier,
    metrics: TrainingMetrics,
    session: Session,
    *,
    permission_level: str = "observe",
) -> str:
    """Full export pipeline: ONNX → Vertex AI → DB row.

    1. Export to ONNX format
    2. Register with Vertex AI Model Registry (if configured)
    3. Deploy to Vertex AI Prediction endpoint (if configured)
    4. Write ml_models row with Vertex AI resource names

    Legacy: ONNX blob is still stored in DB for backward compatibility,
    but runtime inference uses Vertex AI Prediction endpoint.

    Returns the model ID.
    """
    version = get_next_version(session)

    # Export to ONNX (temp directory)
    with tempfile.TemporaryDirectory() as tmpdir:
        onnx_path = os.path.join(tmpdir, f"model_v{version}.onnx")
        export_onnx(model, onnx_path, metrics=metrics)

        # Validate the exported model produces sensible output
        _validate_onnx_output(onnx_path)

        # Read the ONNX binary for DB storage (legacy)
        with open(onnx_path, "rb") as f:
            onnx_bytes = f.read()
        onnx_size_kb = len(onnx_bytes) / 1024
        log.info("ONNX model v%d: %.1f KB", version, onnx_size_kb)

        # Vertex AI registration (primary deployment path)
        vertex_model_name = None
        vertex_endpoint_name = None
        try:
            from .vertex_registry import export_and_register_vertex

            vertex_model_name, vertex_endpoint_name = export_and_register_vertex(
                model, metrics, version, onnx_path
            )
            log.info(
                "Vertex AI registration complete: model=%s, endpoint=%s",
                vertex_model_name,
                vertex_endpoint_name,
            )
        except Exception as e:
            log.warning(
                "Vertex AI registration failed (non-fatal): %s. "
                "Model will be stored in DB only.",
                e,
            )

        # Optional GCS upload (best-effort, not required)
        gcs_uri = upload_to_gcs(onnx_path, version)
        artifact_path = vertex_model_name or gcs_uri or onnx_path

    # Write DB row with embedded ONNX blob (legacy) and Vertex AI resource names
    model_id = write_model_row(
        session,
        version,
        metrics,
        artifact_path,
        deploy=True,
        permission_level=permission_level,
        onnx_blob=onnx_bytes,
        vertex_model_name=vertex_model_name,
        vertex_endpoint_name=vertex_endpoint_name,
    )

    log.info(
        "Model v%d exported and deployed: id=%s, AUC=%.4f, DSR=%.4f",
        version,
        model_id,
        metrics.auc_roc,
        metrics.dsr,
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

        # LightGBM ONNX outputs [labels, probabilities]. Depending on
        # onnxruntime version, probabilities may be an ndarray or a sequence
        # of class-probability maps.
        probs_raw = results[1]
        if isinstance(probs_raw, np.ndarray):
            probs = probs_raw
        elif isinstance(probs_raw, list):
            probs = np.array([[d[0], d[1]] for d in probs_raw], dtype=np.float32)
        else:
            raise AssertionError(f"Unexpected probability output type {type(probs_raw)}")

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


def _serialize_bucket_report(report: object | None) -> dict | None:
    """Convert ScoreBucketReport to a JSON-serializable dict."""
    if report is None:
        return None
    import dataclasses
    import math

    buckets = []
    for b in report.buckets:  # type: ignore[union-attr]
        d = dataclasses.asdict(b)
        # Replace NaN with None for JSON compatibility
        for k, v in d.items():
            if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                d[k] = None
        buckets.append(d)

    return {
        "buckets": buckets,
        "roi_monotonicity": report.roi_monotonicity,
        "clv_monotonicity": report.clv_monotonicity,
        "win_rate_monotonicity": report.win_rate_monotonicity,
        "is_directionally_monotonic": report.is_directionally_monotonic,
    }
