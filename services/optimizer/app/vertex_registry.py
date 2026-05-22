"""Vertex AI Model Registration

Uploads trained LightGBM models to Vertex AI Model Registry and deploys
them to Prediction endpoints. Replaces ONNX export + blob storage.

Architecture:
  1. Export LightGBM model to ONNX (Vertex AI supports ONNX format)
  2. Upload ONNX to GCS bucket (Vertex AI model artifact storage)
  3. Register model in Vertex AI Model Registry
  4. Deploy to Prediction endpoint (or update existing endpoint)
  5. Write ml_models row with Vertex AI resource names

Configuration (via .env):
  GCP_PROJECT_ID — GCP project ID
  GCP_REGION — GCP region (asia-south1)
  VERTEX_MODEL_BUCKET — GCS bucket for model artifacts (gs://bucket-name)
  VERTEX_PREDICTION_ENDPOINT — endpoint ID (optional, creates if missing)
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from google.cloud import aiplatform, storage

if TYPE_CHECKING:
    import lightgbm as lgb
    from .trainer import TrainingMetrics

log = logging.getLogger(__name__)


def get_model_bucket() -> str:
    """Get GCS bucket for Vertex AI model artifacts."""
    bucket = os.getenv("VERTEX_MODEL_BUCKET")
    if not bucket:
        raise ValueError("VERTEX_MODEL_BUCKET not configured")
    # Strip gs:// prefix if present
    return bucket.replace("gs://", "")


def get_project_id() -> str:
    """Get GCP project ID."""
    project = os.getenv("GCP_PROJECT_ID")
    if not project:
        raise ValueError("GCP_PROJECT_ID not configured")
    return project


def get_region() -> str:
    """Get GCP region."""
    region = os.getenv("GCP_REGION")
    if not region:
        raise ValueError("GCP_REGION not configured")
    return region


def upload_model_to_gcs(
    local_onnx_path: str,
    version: int,
) -> str:
    """Upload ONNX model to GCS bucket.

    Returns the GCS URI (gs://bucket/models/v{version}/model.onnx).
    """
    bucket_name = get_model_bucket()
    blob_name = f"models/v{version}/model.onnx"

    storage_client = storage.Client()
    bucket = storage_client.bucket(bucket_name)
    blob = bucket.blob(blob_name)

    blob.upload_from_filename(local_onnx_path)

    gcs_uri = f"gs://{bucket_name}/{blob_name}"
    log.info(f"Uploaded model to {gcs_uri}")
    return gcs_uri


def register_model_in_vertex(
    gcs_uri: str,
    version: int,
    metrics: TrainingMetrics,
) -> str:
    """Register model in Vertex AI Model Registry.

    Returns the Vertex AI model resource name.
    """
    project = get_project_id()
    region = get_region()

    aiplatform.init(project=project, location=region)

    display_name = f"nahidarbx-lightgbm-v{version}"

    # Create model with ONNX artifact
    model = aiplatform.Model.upload(
        display_name=display_name,
        artifact_uri=os.path.dirname(gcs_uri),  # Directory containing model.onnx
        serving_container_image_uri=(
            f"{region}-docker.pkg.dev/vertex-ai/prediction/sklearn-cpu.1-3:latest"
        ),
        labels={
            "version": str(version),
            "framework": "lightgbm",
            "auc_roc": f"{metrics.auc_roc:.4f}",
            "dsr": f"{metrics.dsr:.4f}",
        },
    )

    log.info(f"Registered model: {model.resource_name}")
    return model.resource_name


def deploy_to_endpoint(
    model_resource_name: str,
    version: int,
) -> str:
    """Deploy model to Vertex AI Prediction endpoint.

    If VERTEX_PREDICTION_ENDPOINT is set, deploys to that endpoint.
    Otherwise, creates a new endpoint.

    Returns the endpoint resource name.
    """
    project = get_project_id()
    region = get_region()

    aiplatform.init(project=project, location=region)

    endpoint_id = os.getenv("VERTEX_PREDICTION_ENDPOINT")

    if endpoint_id:
        # Deploy to existing endpoint
        endpoint = aiplatform.Endpoint(endpoint_id)
        log.info(f"Deploying to existing endpoint: {endpoint.resource_name}")
    else:
        # Create new endpoint
        endpoint = aiplatform.Endpoint.create(
            display_name="nahidarbx-lightgbm-endpoint",
            labels={"app": "nahidarbx", "purpose": "bet-scoring"},
        )
        log.info(f"Created new endpoint: {endpoint.resource_name}")

    # Get the model
    model = aiplatform.Model(model_resource_name)

    # Deploy with minimal resources (can scale up later)
    model.deploy(
        endpoint=endpoint,
        deployed_model_display_name=f"lightgbm-v{version}",
        machine_type="n1-standard-2",
        min_replica_count=1,
        max_replica_count=3,
        traffic_percentage=100,  # Route 100% traffic to this version
    )

    log.info(f"Deployed model v{version} to endpoint")
    return endpoint.resource_name


def export_and_register_vertex(
    model: lgb.LGBMClassifier,
    metrics: TrainingMetrics,
    version: int,
    onnx_path: str,
) -> tuple[str, str]:
    """Full Vertex AI export pipeline.

    1. Upload ONNX to GCS
    2. Register in Vertex AI Model Registry
    3. Deploy to Prediction endpoint

    Returns (model_resource_name, endpoint_resource_name).
    """
    # Upload to GCS
    gcs_uri = upload_model_to_gcs(onnx_path, version)

    # Register in Vertex AI
    model_resource_name = register_model_in_vertex(gcs_uri, version, metrics)

    # Deploy to endpoint
    endpoint_resource_name = deploy_to_endpoint(model_resource_name, version)

    return model_resource_name, endpoint_resource_name
