#!/usr/bin/env bash
# Deploys entity-matcher to Cloud Run as an always-on Service.
#
# This service is the ML backbone: hosts BGE-M3 bi-encoder + cross-encoder
# for inference (/embed, /score), AND runs the background ML scheduler that
# processes inbox match pairs autonomously (reads config from matcher_config
# table, writes results to match_pairs + matcher_runs).
#
# Always-on (min-instances=1) because both transformer models take ~15 s
# to load and the scheduler + auto-resolver need sub-second scoring.
#
# Reuses the same Artifact Registry repo and service account as the
# optimizer Job + entity-classifier so we don't proliferate IAM.
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-nahidarbx-6e73}"
REGION="${GCP_REGION:-asia-south1}"
SERVICE_NAME="${ENTITY_MATCHER_NAME:-nahidarbx-entity-matcher}"
REPO="optimizer"
IMAGE_NAME="entity-matcher"
SERVICE_ACCOUNT="optimizer-sa@${PROJECT_ID}.iam.gserviceaccount.com"
INSTANCE_CN="${CLOUD_SQL_INSTANCE:-${PROJECT_ID}:${REGION}:nahidarbx-db}"

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
SHORT_SHA=$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo "manual")
IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE_NAME}"
IMAGE_SHA="${IMAGE_BASE}:${SHORT_SHA}"
IMAGE_LATEST="${IMAGE_BASE}:latest"

echo "▶ Building image ${IMAGE_SHA} via Cloud Build…"
echo "  (this is slow — Hugging Face model bake adds ~5 min and ~5 GB to the image)"
gcloud builds submit --tag "${IMAGE_SHA}" --project "${PROJECT_ID}" "${SCRIPT_DIR}"
gcloud artifacts docker tags add "${IMAGE_SHA}" "${IMAGE_LATEST}" --project "${PROJECT_ID}" 2>/dev/null || true

echo "▶ Deploying ${SERVICE_NAME} → Cloud Run Service…"
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE_SHA}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --service-account "${SERVICE_ACCOUNT}" \
  --no-allow-unauthenticated \
  --memory 8Gi \
  --cpu 2 \
  --min-instances 0 \
  --max-instances 4 \
  --timeout 300 \
  --concurrency 8 \
  --set-cloudsql-instances "${INSTANCE_CN}" \
  --set-env-vars "CLOUD_SQL_INSTANCE=${INSTANCE_CN},ARTEFACT_DIR=/var/lib/entity-matcher" \
  --set-secrets "DATABASE_URL=DATABASE_URL:latest"

URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --project "${PROJECT_ID}" --region "${REGION}" \
  --format='value(status.url)')

echo
echo "✓ Deployed at ${URL}"
echo
echo "Add to .env:"
echo "  ENTITY_MATCHER_URL=${URL}"
echo
echo "Smoke test:"
echo "  TOK=\$(gcloud auth print-identity-token)"
echo "  curl -H \"Authorization: Bearer \$TOK\" ${URL}/healthz"
