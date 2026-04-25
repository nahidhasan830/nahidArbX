#!/usr/bin/env bash
# One-command redeploy: builds the current source + ships to Cloud Run Jobs.
#
# Usage (from repo root or services/optimizer):
#   bash services/optimizer/redeploy.sh
#
# Reads SHORT_SHA from the working tree's HEAD. The deployed image is
# tagged with that SHA and also as :latest. Rollbacks: re-deploy the Job
# pinned to the previous SHA-tagged image:
#   gcloud run jobs update nahidarbx-optimizer-job \
#     --image=<region>-docker.pkg.dev/<project>/<repo>/<image>:<old-sha> \
#     --region=asia-south1

set -euo pipefail

PROJECT_ID=${PROJECT_ID:-nahidarbx-6e73}
REGION=${REGION:-asia-south1}
JOB_NAME=${JOB_NAME:-nahidarbx-optimizer-job}

# Resolve the repo root regardless of where the script is invoked from.
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

SHORT_SHA=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
DIRTY=$(git -C "$REPO_ROOT" status --porcelain | head -c 1)
if [ -n "$DIRTY" ]; then
  printf '⚠ Working tree has uncommitted changes — deploying as %s but those changes WILL be in the image.\n' "$SHORT_SHA"
fi

echo "▶ Submitting build for $SHORT_SHA → Cloud Run Job $JOB_NAME ($REGION)"
gcloud builds submit \
  --config="$REPO_ROOT/cloudbuild.yaml" \
  --substitutions=SHORT_SHA="$SHORT_SHA" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  "$REPO_ROOT"

echo
echo "✓ Deployed Job $JOB_NAME"
gcloud run jobs describe "$JOB_NAME" \
  --region="$REGION" --project="$PROJECT_ID" \
  --format='table(name,latestCreatedExecution.name)' 2>/dev/null || true
echo "  Smoke test: gcloud run jobs executions list --job=$JOB_NAME --region=$REGION --project=$PROJECT_ID --limit=3"
