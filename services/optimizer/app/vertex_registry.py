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
import re
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
PREDICTION_ENDPOINT_DISPLAY_NAME = "nahidarbx-lightgbm-endpoint"
_VERTEX_LABEL_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")


def _vertex_labels(**labels: str | int) -> dict[str, str]:
    """Build Vertex labels and fail locally before the API rejects them."""
    if len(labels) > 64:
        raise ValueError("Vertex AI allows at most 64 labels per resource")

    normalized = {str(k): str(v).lower() for k, v in labels.items()}
    for key, value in normalized.items():
        if not _VERTEX_LABEL_RE.fullmatch(key):
            raise ValueError(f"Invalid Vertex AI label key: {key}")
        if value and not _VERTEX_LABEL_RE.fullmatch(value):
            raise ValueError(f"Invalid Vertex AI label value for {key}: {value}")
    return normalized


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
        labels=_vertex_labels(
            app="nahidarbx",
            version=version,
            framework="lightgbm",
        ),
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
        labels=_vertex_labels(
            app="nahidarbx",
            version=version,
            framework="lightgbm",
        ),
    )
    log.info(f"Registered model: {model.resource_name}")
    return model.resource_name


def deploy_to_endpoint(
    model_resource_name: str,
    version: int,
) -> str:
    """Deploy model to Vertex AI Prediction endpoint.

    If VERTEX_PREDICTION_ENDPOINT is set, deploys to that endpoint.
    Otherwise, reuses the shared endpoint named
    ``nahidarbx-lightgbm-endpoint`` or creates it once.

    Returns the endpoint resource name.
    """
    project = get_project_id()
    region = get_region()

    aiplatform.init(project=project, location=region)

    endpoint = _resolve_prediction_endpoint(project, region)

    # Get the model
    model = aiplatform.Model(model_resource_name)
    deployed_model_display_name = f"lightgbm-v{version}"
    before_deployed_ids = _deployed_model_ids(endpoint)

    # Deploy with one serving replica. The project has an 8-vCPU Vertex custom
    # serving quota in asia-south1; keeping max_replica_count at 1 prevents
    # accepted models from reserving excess quota during rollout.
    deployed_endpoint = model.deploy(
        endpoint=endpoint,
        deployed_model_display_name=deployed_model_display_name,
        machine_type="n1-standard-2",
        min_replica_count=1,
        max_replica_count=1,
        traffic_percentage=100,  # Route 100% traffic to this version
    )
    endpoint = deployed_endpoint or endpoint

    keep_deployed_model_id = _find_deployed_model_id(
        endpoint,
        deployed_model_display_name,
        exclude_ids=before_deployed_ids,
    )
    if keep_deployed_model_id:
        _undeploy_other_models(endpoint, keep_deployed_model_id)
    else:
        log.warning(
            "Could not resolve deployed model id for %s; leaving existing "
            "endpoint deployments untouched",
            deployed_model_display_name,
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


def _resolve_prediction_endpoint(project: str, region: str):
    """Resolve the shared Vertex prediction endpoint, creating it only once."""
    endpoint_id = os.getenv("VERTEX_PREDICTION_ENDPOINT")
    if endpoint_id:
        endpoint = aiplatform.Endpoint(_normalize_endpoint_name(endpoint_id))
        log.info(f"Deploying to configured endpoint: {endpoint.resource_name}")
        return endpoint

    endpoint = _find_shared_prediction_endpoint(project, region)
    if endpoint:
        log.info(f"Reusing shared endpoint: {endpoint.resource_name}")
        return endpoint

    endpoint = aiplatform.Endpoint.create(
        display_name=PREDICTION_ENDPOINT_DISPLAY_NAME,
        labels=_vertex_labels(app="nahidarbx", purpose="bet-scoring"),
    )
    log.info(f"Created shared endpoint: {endpoint.resource_name}")
    return endpoint


def _find_shared_prediction_endpoint(project: str, region: str):
    endpoints = aiplatform.Endpoint.list(
        filter=f'display_name="{PREDICTION_ENDPOINT_DISPLAY_NAME}"',
        order_by="create_time desc",
        project=project,
        location=region,
    )
    if not endpoints:
        return None

    # Prefer the endpoint already serving traffic. Failed deployments can leave
    # empty endpoints behind; selecting an active one avoids endpoint sprawl.
    for endpoint in endpoints:
        if _deployed_model_ids(endpoint):
            return endpoint
    return endpoints[0]


def _deployed_model_ids(endpoint) -> set[str]:
    ids: set[str] = set()
    try:
        deployed_models = endpoint.list_models()
    except Exception as exc:
        log.warning(
            "Could not list deployed models for endpoint %s: %s",
            getattr(endpoint, "resource_name", "<unknown>"),
            exc,
        )
        return ids

    for deployed_model in deployed_models:
        deployed_id = getattr(deployed_model, "id", None)
        if deployed_id:
            ids.add(str(deployed_id))
    return ids


def _find_deployed_model_id(
    endpoint,
    display_name: str,
    *,
    exclude_ids: set[str],
) -> str | None:
    try:
        deployed_models = endpoint.list_models()
    except Exception as exc:
        log.warning(
            "Could not list deployed models after deployment for endpoint %s: %s",
            getattr(endpoint, "resource_name", "<unknown>"),
            exc,
        )
        return None

    fallback_id = None
    for deployed_model in deployed_models:
        deployed_id = getattr(deployed_model, "id", None)
        if not deployed_id:
            continue
        deployed_id = str(deployed_id)
        if getattr(deployed_model, "display_name", None) == display_name:
            if deployed_id not in exclude_ids:
                return deployed_id
            fallback_id = deployed_id
    return fallback_id


def _undeploy_other_models(endpoint, keep_deployed_model_id: str) -> None:
    try:
        deployed_models = endpoint.list_models()
    except Exception as exc:
        log.warning(
            "Could not list stale deployed models for endpoint %s: %s",
            getattr(endpoint, "resource_name", "<unknown>"),
            exc,
        )
        return

    for deployed_model in deployed_models:
        deployed_id = getattr(deployed_model, "id", None)
        if not deployed_id:
            continue
        deployed_id = str(deployed_id)
        if deployed_id == keep_deployed_model_id:
            continue
        log.info(
            "Undeploying stale Vertex deployed model %s from endpoint %s",
            deployed_id,
            getattr(endpoint, "resource_name", "<unknown>"),
        )
        endpoint.undeploy(deployed_model_id=deployed_id, sync=True)


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
