"""Vertex AI Model Registration

Uploads trained LightGBM models to Vertex AI Model Registry and deploys
them to Prediction endpoints. Replaces ONNX export + blob storage.

Architecture:
  1. Export LightGBM model to ONNX (Vertex AI supports ONNX format)
  2. Upload ONNX to GCS bucket (Vertex AI model artifact storage)
  3. Register model in Vertex AI Model Registry with the optimizer image as a
     custom ONNX prediction container
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

DEFAULT_SERVING_IMAGE = (
    "asia-south1-docker.pkg.dev/nahidarbx-6e73/optimizer/nahidarbx-optimizer:latest"
)


def get_model_bucket() -> str:
    """Get GCS bucket for Vertex AI model artifacts."""
    bucket = os.getenv("VERTEX_MODEL_BUCKET") or os.getenv("ML_MODEL_BUCKET")
    if not bucket:
        raise ValueError("VERTEX_MODEL_BUCKET or ML_MODEL_BUCKET not configured")
    # Strip gs:// prefix if present
    return bucket.replace("gs://", "")


def get_project_id() -> str:
    """Get GCP project ID."""
    project = os.getenv("GCP_PROJECT_ID") or os.getenv("GOOGLE_CLOUD_PROJECT")
    if not project:
        raise ValueError("GCP_PROJECT_ID or GOOGLE_CLOUD_PROJECT not configured")
    return project


def get_region() -> str:
    """Get GCP region."""
    region = os.getenv("GCP_REGION") or os.getenv("GOOGLE_CLOUD_REGION")
    if not region:
        raise ValueError("GCP_REGION or GOOGLE_CLOUD_REGION not configured")
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


def get_serving_image() -> str:
    """Image used by Vertex AI to serve ONNX predictions."""
    return os.getenv("VERTEX_SERVING_IMAGE") or DEFAULT_SERVING_IMAGE


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

    # Create model with ONNX artifact. Vertex starts the same optimizer image
    # with a different command so it behaves as an HTTP prediction container.
    model = aiplatform.Model.upload(
        display_name=display_name,
        artifact_uri=os.path.dirname(gcs_uri),  # Directory containing model.onnx
        serving_container_image_uri=get_serving_image(),
        serving_container_command=["python", "-m", "app.vertex_server"],
        serving_container_predict_route="/predict",
        serving_container_health_route="/health",
        serving_container_ports=[8080],
        labels={
            "version": str(version),
            "framework": "lightgbm",
            "auc_roc": f"{metrics.auc_roc:.4f}",
            "dsr": f"{metrics.dsr:.4f}",
        },
    )

    log.info(f"Registered model: {model.resource_name}")
    return model.resource_name


def register_onnx_in_vertex(
    gcs_uri: str,
    version: int,
) -> str:
    """Register an ONNX artifact without training metrics.

    Used by operational repair scripts when a DB row already has a stored
    ONNX blob but the original training job failed before Vertex deployment.
    """
    project = get_project_id()
    region = get_region()

    aiplatform.init(project=project, location=region)
    model = aiplatform.Model.upload(
        display_name=f"nahidarbx-lightgbm-v{version}",
        artifact_uri=os.path.dirname(gcs_uri),
        serving_container_image_uri=get_serving_image(),
        serving_container_command=["python", "-m", "app.vertex_server"],
        serving_container_predict_route="/predict",
        serving_container_health_route="/health",
        serving_container_ports=[8080],
        labels={
            "version": str(version),
            "framework": "lightgbm",
            "app": "nahidarbx",
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
        endpoint = aiplatform.Endpoint(_normalize_endpoint_name(endpoint_id))
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


def _normalize_endpoint_name(endpoint: str) -> str:
    """Accept endpoint id, endpoints/{id}, or full resource name."""
    endpoint = endpoint.strip()
    if endpoint.startswith("projects/"):
        return endpoint
    if endpoint.startswith("endpoints/"):
        endpoint = endpoint.removeprefix("endpoints/")
    return (
        f"projects/{get_project_id()}/locations/{get_region()}/endpoints/{endpoint}"
    )


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


def deploy_onnx_path_to_vertex(
    onnx_path: str,
    version: int,
) -> tuple[str, str]:
    """Upload, register, and deploy an already exported ONNX model."""
    gcs_uri = upload_model_to_gcs(onnx_path, version)
    model_resource_name = register_onnx_in_vertex(gcs_uri, version)
    endpoint_resource_name = deploy_to_endpoint(model_resource_name, version)
    return model_resource_name, endpoint_resource_name
