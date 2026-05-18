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

RESULT=$(gcloud run jobs execute "$JOB_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --update-env-vars="$ENV_VARS" \
  --async \
  --quiet 2>&1)
echo "$RESULT"

EXECUTION_NAME=$(printf '%s\n' "$RESULT" | sed -nE 's/.*describe ([^[:space:]]+).*/\1/p' | tail -1)
if [[ -z "$EXECUTION_NAME" ]]; then
  EXECUTION_NAME=$(gcloud run jobs executions list \
    --job="$JOB_NAME" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --sort-by="~metadata.creationTimestamp" \
    --limit=1 \
    --format="value(metadata.name)")
fi

if [[ -z "$EXECUTION_NAME" ]]; then
  echo "✗ Could not determine Cloud Run execution name"
  exit 1
fi

echo "▶ Watching execution: $EXECUTION_NAME"
POLL_INTERVAL=${TRAINING_JOB_POLL_INTERVAL:-10}
MAX_WAIT=${TRAINING_JOB_MAX_WAIT:-1800}
ELAPSED=0

while [[ "$ELAPSED" -le "$MAX_WAIT" ]]; do
  STATUS_JSON=$(gcloud run jobs executions describe "$EXECUTION_NAME" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --format=json 2>/dev/null || true)

  COMPLETED_STATUS=$(printf '%s' "$STATUS_JSON" | python3 -c 'import json,sys
try:
    data=json.load(sys.stdin)
except Exception:
    print("")
    raise SystemExit
for condition in data.get("status", {}).get("conditions", []):
    if condition.get("type") == "Completed":
        print(condition.get("status", ""))
        break
')
  STARTED_STATUS=$(printf '%s' "$STATUS_JSON" | python3 -c 'import json,sys
try:
    data=json.load(sys.stdin)
except Exception:
    print("")
    raise SystemExit
for condition in data.get("status", {}).get("conditions", []):
    if condition.get("type") == "Started":
        print(condition.get("status", ""))
        break
')
  MESSAGE=$(printf '%s' "$STATUS_JSON" | python3 -c 'import json,sys
try:
    data=json.load(sys.stdin)
except Exception:
    print("")
    raise SystemExit
for condition in data.get("status", {}).get("conditions", []):
    if condition.get("type") == "Completed":
        print(condition.get("message", ""))
        break
')

  if [[ "$COMPLETED_STATUS" == "True" ]]; then
    echo "[$ELAPSED s] Status: Succeeded ${MESSAGE:+— $MESSAGE}"
    echo "✓ Cloud training pipeline complete"
    exit 0
  fi
  if [[ "$COMPLETED_STATUS" == "False" ]]; then
    echo "[$ELAPSED s] Status: Failed ${MESSAGE:+— $MESSAGE}"
    exit 1
  fi

  if [[ "$STARTED_STATUS" == "True" ]]; then
    echo "[$ELAPSED s] Status: Running"
  else
    echo "[$ELAPSED s] Status: Starting"
  fi

  sleep "$POLL_INTERVAL"
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

echo "✗ Training timed out after ${MAX_WAIT}s"
exit 1
