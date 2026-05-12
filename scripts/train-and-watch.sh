#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# train-and-watch.sh
#
# End-to-end training pipeline monitor.
# 1. Triggers training via the same POST /api/ml/retrain the UI uses.
# 2. Polls the DB every 10s, printing status + elapsed time.
# 3. Exits with 0 on success, 1 on failure, 2 on timeout.
#
# Usage:
#   bash scripts/train-and-watch.sh          # default: http://localhost:3000
#   BASE_URL=http://host:port bash scripts/train-and-watch.sh
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
TIMEOUT_MINUTES="${TIMEOUT_MINUTES:-50}"
POLL_INTERVAL=10

REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." &>/dev/null && pwd)
PYTHON="${REPO_ROOT}/services/optimizer/.venv/bin/python"

# ── Colors ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN} ML Training Pipeline — End-to-End Monitor${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

# ── Step 1: Check for existing training runs ──────────────────────────
echo -e "${YELLOW}▶ Step 1: Checking for existing training runs...${NC}"
EXISTING=$("$PYTHON" -c "
from app.db import open_session
from sqlalchemy import text
s = open_session()
rows = s.execute(text(\"SELECT id, status FROM ml_models WHERE status = 'training'\")).fetchall()
s.close()
print(len(rows))
" 2>/dev/null || echo "0")

if [ "$EXISTING" != "0" ]; then
  echo -e "${RED}  ✗ There is already a training run in progress. Aborting.${NC}"
  echo "  Use: $PYTHON -c \"from app.db import open_session; from sqlalchemy import text; s=open_session(); s.execute(text(\\\"UPDATE ml_models SET status='failed', training_completed_at=now() WHERE status='training'\\\")); s.commit()"
  exit 1
fi
echo -e "${GREEN}  ✓ No active training runs${NC}"
echo ""

# ── Step 2: Trigger training via API ──────────────────────────────────
echo -e "${YELLOW}▶ Step 2: Triggering training via POST ${BASE_URL}/api/ml/retrain${NC}"
HTTP_CODE=$(curl -s -o /tmp/ml-train-response.json -w "%{http_code}" -X POST "${BASE_URL}/api/ml/retrain")
BODY=$(cat /tmp/ml-train-response.json 2>/dev/null || echo "{}")

if [ "$HTTP_CODE" != "200" ]; then
  echo -e "${RED}  ✗ API returned HTTP ${HTTP_CODE}${NC}"
  echo "  Response: $BODY"
  exit 1
fi

MODEL_ID=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin).get('modelId', 'unknown'))" 2>/dev/null || echo "unknown")
echo -e "${GREEN}  ✓ Training triggered — modelId: ${MODEL_ID}${NC}"
echo ""

# ── Step 3: Poll DB for status ────────────────────────────────────────
echo -e "${YELLOW}▶ Step 3: Monitoring training progress (poll every ${POLL_INTERVAL}s, timeout ${TIMEOUT_MINUTES}min)${NC}"
echo ""

START_TIME=$(date +%s)
DEADLINE=$((START_TIME + TIMEOUT_MINUTES * 60))

while true; do
  NOW=$(date +%s)
  ELAPSED=$((NOW - START_TIME))
  ELAPSED_MIN=$((ELAPSED / 60))
  ELAPSED_SEC=$((ELAPSED % 60))

  if [ "$NOW" -gt "$DEADLINE" ]; then
    echo ""
    echo -e "${RED}  ✗ TIMEOUT: Training did not complete within ${TIMEOUT_MINUTES} minutes${NC}"
    exit 2
  fi

  # Query the DB for the model status
  STATUS_LINE=$("$PYTHON" -c "
from app.db import open_session
from sqlalchemy import text
import json
s = open_session()
rows = s.execute(text('''
  SELECT id, version, status, training_samples,
         rejection_reasons, oos_auc_roc, deflated_sharpe,
         pbo, permission_level,
         training_started_at, training_completed_at
  FROM ml_models
  ORDER BY created_at DESC
  LIMIT 1
''')).fetchall()
s.close()
if rows:
    r = rows[0]._mapping
    out = {
        'id': r['id'], 'version': r['version'], 'status': r['status'],
        'samples': r['training_samples'],
        'reasons': r['rejection_reasons'],
        'auc': float(r['oos_auc_roc']) if r['oos_auc_roc'] else None,
        'dsr': float(r['deflated_sharpe']) if r['deflated_sharpe'] else None,
        'pbo': float(r['pbo']) if r['pbo'] else None,
        'permission': r['permission_level'],
        'completed': str(r['training_completed_at']) if r['training_completed_at'] else None,
    }
    print(json.dumps(out))
else:
    print('{}')
" 2>/dev/null)

  STATUS=$(echo "$STATUS_LINE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('status', 'unknown'))" 2>/dev/null || echo "unknown")
  VERSION=$(echo "$STATUS_LINE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('version', '?'))" 2>/dev/null || echo "?")

  TIMESTAMP=$(date +"%H:%M:%S")

  case "$STATUS" in
    training)
      echo -e "  ${CYAN}[${TIMESTAMP}]${NC} ⏳ Training in progress...  (${ELAPSED_MIN}m${ELAPSED_SEC}s elapsed)"
      ;;
    deployed)
      AUC=$(echo "$STATUS_LINE" | python3 -c "import sys, json; d=json.load(sys.stdin); print(f'{d[\"auc\"]:.4f}' if d.get('auc') else '—')" 2>/dev/null)
      DSR=$(echo "$STATUS_LINE" | python3 -c "import sys, json; d=json.load(sys.stdin); print(f'{d[\"dsr\"]:.3f}' if d.get('dsr') else '—')" 2>/dev/null)
      PBO=$(echo "$STATUS_LINE" | python3 -c "import sys, json; d=json.load(sys.stdin); print(f'{d[\"pbo\"]:.3f}' if d.get('pbo') else '—')" 2>/dev/null)
      PERM=$(echo "$STATUS_LINE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('permission', '—'))" 2>/dev/null)
      SAMPLES=$(echo "$STATUS_LINE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('samples', '—'))" 2>/dev/null)
      echo ""
      echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
      echo -e "${GREEN} ✓ MODEL DEPLOYED SUCCESSFULLY (${ELAPSED_MIN}m${ELAPSED_SEC}s)${NC}"
      echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
      echo -e "  Version:    v${VERSION}"
      echo -e "  Samples:    ${SAMPLES}"
      echo -e "  AUC:        ${AUC}"
      echo -e "  DSR:        ${DSR}"
      echo -e "  PBO:        ${PBO}"
      echo -e "  Permission: ${PERM}"
      echo ""
      exit 0
      ;;
    rejected)
      REASONS=$(echo "$STATUS_LINE" | python3 -c "import sys, json; d=json.load(sys.stdin); [print(f'    - {r}') for r in (d.get('reasons') or ['No reasons given'])]" 2>/dev/null)
      echo ""
      echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
      echo -e "${YELLOW} ⚠ MODEL REJECTED BY DEPLOYMENT GATE (${ELAPSED_MIN}m${ELAPSED_SEC}s)${NC}"
      echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
      echo -e "  Reasons:"
      echo "$REASONS"
      echo ""
      echo -e "  (This is normal — the gate ensures only quality models deploy.)"
      exit 0
      ;;
    failed)
      REASONS=$(echo "$STATUS_LINE" | python3 -c "import sys, json; d=json.load(sys.stdin); [print(f'    - {r}') for r in (d.get('reasons') or ['No reasons given'])]" 2>/dev/null)
      echo ""
      echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
      echo -e "${RED} ✗ TRAINING FAILED (${ELAPSED_MIN}m${ELAPSED_SEC}s)${NC}"
      echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
      echo -e "  Reasons:"
      echo "$REASONS"
      echo ""

      # Also pull the most recent Cloud Run execution logs
      echo -e "${YELLOW}  Fetching Cloud Run Job logs...${NC}"
      EXEC_NAME=$(gcloud run jobs executions list \
        --job=nahidarbx-optimizer-job \
        --region=asia-south1 \
        --project=nahidarbx-6e73 \
        --limit=1 \
        --format="value(name)" 2>/dev/null || echo "")
      if [ -n "$EXEC_NAME" ]; then
        echo -e "  Execution: ${EXEC_NAME}"
        gcloud logging read "resource.type=\"cloud_run_job\" resource.labels.job_name=\"nahidarbx-optimizer-job\" labels.\"run.googleapis.com/execution_name\"=\"${EXEC_NAME}\"" \
          --project=nahidarbx-6e73 --limit=15 --format="value(textPayload)" 2>/dev/null | head -20 | while read -r line; do
          [ -n "$line" ] && echo -e "  ${RED}│${NC} $line"
        done
      fi
      echo ""
      exit 1
      ;;
    *)
      echo -e "  ${CYAN}[${TIMESTAMP}]${NC} ❓ Status: ${STATUS}  (${ELAPSED_MIN}m${ELAPSED_SEC}s elapsed)"
      ;;
  esac

  sleep "$POLL_INTERVAL"
done
