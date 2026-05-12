#!/usr/bin/env bash
# Cloud Train: build fresh image → deploy → run the Cloud Run Job.
#
# Called by the retrain API. Ensures the Docker image always matches
# the current source code, eliminating stale-image failures.
#
# Env vars (set by caller):
#   SHORT_SHA                  — git short SHA for image tagging
#   EXPECTED_FEATURE_VERSION   — passed to the Cloud Run Job as env override
#   TRAINING_MODEL_ID          — ml_models row ID (for error recovery)
#
# Uses the existing cloudbuild.yaml which handles:
#   build → push to Artifact Registry → deploy to Cloud Run Job

set -euo pipefail

REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." &>/dev/null && pwd)

PROJECT_ID=${PROJECT_ID:-nahidarbx-6e73}
REGION=${GCP_REGION:-asia-south1}
JOB_NAME=${OPTIMIZER_JOB_NAME:-nahidarbx-optimizer-job}
SHORT_SHA=${SHORT_SHA:-$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "dev")}

echo "▶ Step 1/2: Building + deploying fresh image (SHA=$SHORT_SHA)"
gcloud builds submit \
  --config="$REPO_ROOT/cloudbuild.yaml" \
  --substitutions=SHORT_SHA="$SHORT_SHA" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  "$REPO_ROOT"

echo "▶ Step 2/2: Running Cloud Run Job ($JOB_NAME)"
ENV_VARS="EXPECTED_FEATURE_VERSION=${EXPECTED_FEATURE_VERSION:-2}"
if [[ -n "${TRAINING_MODEL_ID:-}" ]]; then
  ENV_VARS="$ENV_VARS,TRAINING_MODEL_ID=$TRAINING_MODEL_ID"
fi

gcloud run jobs execute "$JOB_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --update-env-vars="$ENV_VARS" \
  --wait

echo "✓ Cloud training pipeline complete"
