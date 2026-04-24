#!/usr/bin/env bash
# One-command redeploy: builds the current source + ships to Cloud Run.
#
# Usage (from repo root or services/optimizer):
#   bash services/optimizer/redeploy.sh
#
# Reads SHORT_SHA from the working tree's HEAD. The deployed image is
# tagged with that SHA and also as :latest, so rollbacks are a one-liner:
#   gcloud run services update-traffic nahidarbx-optimizer \
#     --to-revisions=<previous-revision>=100 --region=asia-south1
#
# When you set up the GitHub Cloud Build trigger (see services/optimizer/README.md
# § "Production deployment"), this script becomes optional — every push to
# main affecting services/optimizer/** will redeploy automatically.

set -euo pipefail

PROJECT_ID=${PROJECT_ID:-nahidarbx-6e73}
REGION=${REGION:-asia-south1}

# Resolve the repo root regardless of where the script is invoked from.
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

SHORT_SHA=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
DIRTY=$(git -C "$REPO_ROOT" status --porcelain | head -c 1)
if [ -n "$DIRTY" ]; then
  printf '⚠ Working tree has uncommitted changes — deploying as %s but those changes WILL be in the image.\n' "$SHORT_SHA"
fi

echo "▶ Submitting build for $SHORT_SHA → Cloud Run service nahidarbx-optimizer ($REGION)"
gcloud builds submit \
  --config="$REPO_ROOT/cloudbuild.yaml" \
  --substitutions=SHORT_SHA="$SHORT_SHA" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  "$REPO_ROOT"

echo
SERVICE_URL=$(gcloud run services describe nahidarbx-optimizer \
  --region="$REGION" --project="$PROJECT_ID" --format='value(status.url)')
echo "✓ Deployed: $SERVICE_URL"
echo "  Smoke test: curl $SERVICE_URL/health"
